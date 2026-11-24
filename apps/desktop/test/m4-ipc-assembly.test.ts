import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { MainToWorkerMessage, ProfileContent, WorkerToMainMessage } from '@jobhelper/contracts';
import type { ManagedWebContentsView, WebContentsViewFactory } from '@jobhelper/browser-bridge';
import { InMemoryCredentialStore } from '@jobhelper/model-router';
import {
  createDesktopMainKernel,
  registerDesktopIpcHandlers,
  type WorkerChildTransport,
} from '../src/main/index.js';
import { createJobHelperPreloadApi } from '../src/preload/index.js';

const PROFILE_SAMPLE: ProfileContent = {
  basic: { fullName: '陈测试', email: 'chen@example.com', city: '深圳' },
  education: [],
  internships: [],
  projects: [],
  skills: ['TypeScript', 'React'],
};

function stubViews(): WebContentsViewFactory {
  let n = 0;
  return {
    createView: ({ initialBounds }) => {
      const id = `v-${++n}`;
      let url = '';
      let bounds = { ...initialBounds };
      let visible = false;
      let destroyed = false;
      const emitter = new EventEmitter();
      const dbgEmitter = new EventEmitter();
      const view: ManagedWebContentsView = {
        webContents: {
          isDestroyed: () => destroyed,
          getURL: () => url,
          getTitle: () => 'Mock Page',
          getUserAgent: () => 'JobHelper/0.1',
          getZoomFactor: () => 1,
          loadURL: async (u) => {
            url = u;
            emitter.emit('did-navigate');
            emitter.emit('did-stop-loading');
          },
          executeJavaScript: async () => undefined as never,
          capturePagePngBase64: async () => ({ base64: 'iVBORw0KGgo=', width: 800, height: 600 }),
          debugger: {
            isAttached: () => true,
            attach: () => {},
            detach: () => {},
            sendCommand: async () => ({ targetInfo: { targetId: id } }),
            on: (e, fn) => {
              dbgEmitter.on(e, fn);
            },
            removeListener: (e, fn) => {
              dbgEmitter.removeListener(e, fn);
            },
          },
          on: (e, fn) => {
            emitter.on(e, fn);
          },
          removeListener: (e, fn) => {
            emitter.removeListener(e, fn);
          },
        },
        setBounds: (b) => {
          bounds = { ...b };
        },
        getBounds: () => ({ ...bounds }),
        setVisible: (v) => {
          visible = v;
        },
        getVisible: () => visible,
        destroy: () => {
          destroyed = true;
        },
      };
      return view;
    },
  };
}

function stubWorker(): WorkerChildTransport {
  const handlers: Array<(m: WorkerToMainMessage) => void> = [];
  return {
    send: (_m: MainToWorkerMessage) => {},
    onMessage: (h) => {
      handlers.push(h);
      setImmediate(() => h({ type: 'worker_ready' }));
    },
    onExit: () => {},
    kill: () => {},
  };
}

describe('@jobhelper/desktop M4 Full IPC, Runtime/Tools Assembly & Option A External Skills', () => {
  it('wires all workbench IPC channels, hides plaintext API keys, mounts external skills dir, and registers full coordinator/application toolsets', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhelper-m4-'));
    const extSkillsDir = path.join(tmpDir, 'ext-skills');
    fs.mkdirSync(path.join(extSkillsDir, 'ats-external-test'), { recursive: true });
    fs.writeFileSync(
      path.join(extSkillsDir, 'ats-external-test', 'SKILL.md'),
      '---\nname: ats-external-test\ndescription: External test manual\ndomains: ["*.ext.test"]\n---\n# External Manual Body',
      'utf8',
    );

    const creds = new InMemoryCredentialStore();
    const kernel = createDesktopMainKernel({
      dbPath: path.join(tmpDir, 'm4.db'),
      materialsRootDir: path.join(tmpDir, 'materials'),
      artifactsRootDir: path.join(tmpDir, 'artifacts'),
      credentials: creds,
      viewFactory: stubViews(),
      spawnWorker: stubWorker,
    });

    const handlers = new Map<string, (_e: unknown, arg: unknown) => Promise<unknown>>();
    registerDesktopIpcHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, kernel.ipcRouter);
    const api = createJobHelperPreloadApi({
      invoke: async (ch, arg) => handlers.get(ch)!({}, arg),
    });

    try {
      kernel.start();

      // Verify full M3+M6 toolsets are wired into the desktop kernel
      expect(kernel.agentEngine.registry.listForRole('coordinator').length).toBe(11);
      expect(kernel.agentEngine.registry.listForRole('application').length).toBe(28);

      // 1. Save BYOK provider -> key written to CredentialStore, NEVER echoed in DTO
      const savedProv = await api['providers:save']({
        name: 'DeepSeek 主力',
        providerType: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-chat',
        apiKey: 'sk-never-return-this-key',
      });
      expect(savedProv.hasSecret).toBe(true);
      expect(JSON.stringify(savedProv)).not.toContain('sk-never-return-this-key');
      expect(await creds.getSecret(savedProv.config.credentialKey)).toBe('sk-never-return-this-key');

      // 2. Profile + Material + Facts + Position
      const { profile } = await api['profiles:create']({
        name: '默认简历',
        content: PROFILE_SAMPLE,
        setAsDefault: true,
      });
      const mat = await api['materials:importBuffer']({
        profileId: profile.id,
        kind: 'resume_pdf',
        fileName: 'chen.pdf',
        mimeType: 'application/pdf',
        base64Data: Buffer.from('%PDF-1.4 test').toString('base64'),
      });
      await api['profiles:setDefaultResume']({ profileId: profile.id, materialId: mat.id });

      const pos = await api['positions:add']({
        company: 'ExtCorp',
        jobTitle: 'SWE',
        applyUrl: 'https://jobs.ext.test/apply/1',
      });
      expect(pos.progressStage).toBe('saved');

      // 3. Coordinator + Application Task Detail Projection
      const coord = await api['tasks:getCoordinator']();
      expect(coord.kind).toBe('coordinator');

      const { taskId } = await api['tasks:startApplication']({
        applyUrl: pos.applyUrl,
        positionId: pos.id,
        originConversationId: coord.id,
      });
      const proj = await api['tasks:getProjection']({ taskId });
      expect(proj.profileSnapshot?.content.basic.fullName).toBe('陈测试');
      expect(proj.authorizedMaterials.map((m) => m.fileName)).toEqual(['chen.pdf']);
      expect(proj.tabs).toHaveLength(1);

      // 4. Option A: Mount external local Skills dir via settings:update & load on demand
      const beforeSkills = await api['skills:list']();
      expect(beforeSkills.skills.every((s) => s.source === 'builtin')).toBe(true);

      await api['settings:update']({ maxConcurrent: 4, externalSkillDirs: [extSkillsDir] });
      const afterSkills = await api['skills:list']();
      expect(afterSkills.skills.some((s) => s.name === 'ats-external-test' && s.source === 'external')).toBe(
        true,
      );
      const loadedExt = await api['skills:load']({ skillName: 'ats-external-test' });
      expect(loadedExt?.bodyMarkdown).toContain('External Manual Body');

      // 5. M6 Skill Draft loop: application submits draft -> Settings lists & approves it
      const draftRes = await kernel.agentEngine.registry.invoke(
        'submit_skill_draft',
        {
          skillName: 'ats-mokahr',
          diffOrContent: '## 新增提示\n- 某企业站点需要等待 500ms 远程院校搜索',
        },
        {
          taskId,
          role: 'application',
          runId: 'run-draft-1' as never,
          epoch: 1 as never,
          callId: 'call-draft-1',
          authorizedMaterialIds: [],
          signal: new AbortController().signal,
        },
      );
      expect(draftRes.ok).toBe(true);
      const pendingDrafts = await api['skills:listDrafts']({ status: 'draft' });
      expect(pendingDrafts).toHaveLength(1);
      expect(pendingDrafts[0]?.skillName).toBe('ats-mokahr');
      await api['skills:reviewDraft']({ draftId: pendingDrafts[0]!.id, status: 'approved' });
      const approvedDrafts = await api['skills:listDrafts']({ status: 'approved' });
      expect(approvedDrafts).toHaveLength(1);
      expect(approvedDrafts[0]?.reviewedAt).toBeTruthy();
    } finally {
      await kernel.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
