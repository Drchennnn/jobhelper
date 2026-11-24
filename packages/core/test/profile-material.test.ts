import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProfileContent } from '@jobhelper/contracts';
import { createSqliteStorage } from '@jobhelper/storage';
import { LocalMaterialService, LocalProfileService } from '../src/index.js';

const BASE_CONTENT: ProfileContent = {
  basic: {
    fullName: '林星河',
    phone: '13800138000',
    email: 'lin@example.com',
    city: '上海',
  },
  education: [
    {
      school: '复旦大学',
      degree: '硕士',
      major: '计算机技术',
      startDate: '2024-09',
      endDate: '2027-06',
    },
  ],
  internships: [],
  projects: [],
  skills: ['TypeScript', 'React', 'Node.js'],
};

describe('@jobhelper/core Profile & Material Services', () => {
  it('creates immutable profile snapshots and isolates existing task snapshots when profile or default changes', () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    try {
      const service = new LocalProfileService(storage.uow, storage.profiles, storage.preferences);

      const createdA = service.createProfile({ name: '前端校招版', content: BASE_CONTENT });
      expect(createdA.snapshot.versionNumber).toBe(1);
      expect(service.getDefaultProfileId()).toBe(createdA.profile.id);

      // Idempotent update with identical content does not create a redundant version
      const sameUpdate = service.updateProfileContent(createdA.profile.id, structuredClone(BASE_CONTENT));
      expect(sameUpdate.snapshot.id).toBe(createdA.snapshot.id);
      expect(service.listVersions(createdA.profile.id)).toHaveLength(1);

      // Updating content produces version 2 while version 1 remains immutable
      const updatedA = service.updateProfileContent(createdA.profile.id, {
        ...BASE_CONTENT,
        basic: { ...BASE_CONTENT.basic, city: '北京' },
      });
      expect(updatedA.snapshot.versionNumber).toBe(2);
      expect(updatedA.snapshot.id).not.toBe(createdA.snapshot.id);
      expect(service.getSnapshot(createdA.snapshot.id)?.content.basic.city).toBe('上海');
      expect(service.getSnapshot(updatedA.snapshot.id)?.content.basic.city).toBe('北京');

      // Switching global default profile to B does not mutate profile A's versions
      const createdB = service.createProfile({
        name: 'AI 工程版',
        content: { ...BASE_CONTENT, skills: ['Python', 'LLM'] },
        setAsDefault: true,
      });
      expect(service.getDefaultProfileId()).toBe(createdB.profile.id);
      expect(service.getSnapshot(createdA.snapshot.id)?.content.skills).toEqual([
        'TypeScript',
        'React',
        'Node.js',
      ]);

      // Upsert user facts cleanly
      const fact1 = service.rememberFact({
        scope: 'global',
        key: '可到岗时间',
        value: '2026-12',
        source: 'question_reply',
      });
      const fact2 = service.rememberFact({
        scope: 'global',
        key: '可到岗时间',
        value: '随时到岗',
        source: 'user_edit',
      });
      expect(fact2.id).toBe(fact1.id);
      expect(service.listFacts(createdA.profile.id)[0]?.value).toBe('随时到岗');
    } finally {
      storage.close();
    }
  });

  it('stores materials with SHA-256 verification, enforces task authorization, and paginates text safely', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhelper-materials-'));
    const storage = createSqliteStorage({ filename: ':memory:' });
    try {
      const profileService = new LocalProfileService(storage.uow, storage.profiles, storage.preferences);
      const materialService = new LocalMaterialService(storage.uow, storage.profiles, {
        rootDir: tmpDir,
        maxFileSizeBytes: 1024 * 1024,
      });

      const { profile } = profileService.createProfile({ name: '默认档案', content: BASE_CONTENT });
      const textDoc = materialService.importFromBuffer({
        profileId: profile.id,
        kind: 'other',
        fileName: '../../../evil-resume-notes.txt',
        mimeType: 'text/plain',
        data: Buffer.from('0123456789ABCDEF', 'utf8'),
      });
      expect(textDoc.fileName).toBe('evil-resume-notes.txt');
      expect(textDoc.relativePath).toMatch(/^materials\/[a-f0-9-]+\/evil-resume-notes\.txt$/);

      // Setting default resume attachment does NOT bump profile version
      const pdfDoc = materialService.importFromBuffer({
        profileId: profile.id,
        kind: 'resume_pdf',
        fileName: 'LinXinghe.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 fake pdf bytes', 'utf8'),
      });
      const updatedProfile = profileService.setDefaultResumeMaterial(profile.id, pdfDoc.id);
      expect(updatedProfile.defaultResumeMaterialId).toBe(pdfDoc.id);
      expect(profileService.listVersions(profile.id)).toHaveLength(1);

      // Paginated text read with task authorization enforcement
      const page1 = materialService.readTextSlice({
        materialId: textDoc.id,
        authorizedMaterialIds: [textDoc.id],
        offset: 0,
        limit: 10,
      });
      expect(page1.content).toBe('0123456789');
      expect(page1.nextOffset).toBe(10);

      const page2 = materialService.readTextSlice({
        materialId: textDoc.id,
        authorizedMaterialIds: [textDoc.id],
        offset: page1.nextOffset!,
        limit: 10,
      });
      expect(page2.content).toBe('ABCDEF');
      expect(page2.nextOffset).toBeNull();

      // Unauthorized access is blocked
      expect(() =>
        materialService.readAuthorizedBuffer(pdfDoc.id, [textDoc.id]),
      ).toThrow(/未授权/);

      // Tampering disk bytes triggers SHA-256 integrity failure
      const onDisk = path.join(tmpDir, textDoc.relativePath);
      fs.writeFileSync(onDisk, 'corrupted!', 'utf8');
      expect(() => materialService.readAuthorizedBuffer(textDoc.id)).toThrow(/完整性校验失败/);
    } finally {
      storage.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
