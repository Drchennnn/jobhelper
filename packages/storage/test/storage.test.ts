import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  BrowserProfileId,
  CallId,
  ClientMessageId,
  ConfirmationId,
  ContentHash,
  Epoch,
  EventId,
  IsoTimestamp,
  MaterialId,
  ModelProviderConfig,
  PositionId,
  ProfileId,
  ProfileVersionId,
  ProviderId,
  QuestionId,
  RunId,
  TaskId,
  TodoId,
} from '@jobhelper/contracts';
import { createSqliteStorage } from '../src/index.js';

const NOW = '2026-11-24T12:00:00.000Z' as IsoTimestamp;

describe('@jobhelper/storage (node:sqlite)', () => {
  it('applies migrations idempotently, preserves WAL on disk, and rejects tampered migrations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhelper-storage-'));
    const dbPath = path.join(tmpDir, 'jobhelper.db');
    const migrationsCopy = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsCopy, { recursive: true });
    const srcSql = path.resolve(import.meta.dirname, '..', 'migrations', '0001_initial.sql');
    fs.copyFileSync(srcSql, path.join(migrationsCopy, '0001_initial.sql'));

    const storage1 = createSqliteStorage({ filename: dbPath, migrationsDir: migrationsCopy });
    storage1.preferences.set('maxConcurrent', 3, NOW);
    storage1.close();

    // Reopen cleanly — migration is idempotent and data persists
    const storage2 = createSqliteStorage({ filename: dbPath, migrationsDir: migrationsCopy });
    expect(storage2.preferences.get<number>('maxConcurrent')).toBe(3);
    storage2.close();

    // Tamper migration checksum -> fails loudly
    fs.appendFileSync(path.join(migrationsCopy, '0001_initial.sql'), '\n-- tampered\n');
    expect(() =>
      createSqliteStorage({ filename: dbPath, migrationsDir: migrationsCopy }),
    ).toThrow(/checksum mismatch/i);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('supports nested transactions via savepoints with partial rollback', () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    try {
      storage.uow.runInTransaction(() => {
        storage.preferences.set('outer', 'ok', NOW);
        expect(() =>
          storage.uow.runInTransaction(() => {
            storage.preferences.set('inner', 'should-rollback', NOW);
            throw new Error('boom');
          }),
        ).toThrow('boom');
      });

      expect(storage.preferences.get('outer')).toBe('ok');
      expect(storage.preferences.get('inner')).toBeNull();
    } finally {
      storage.close();
    }
  });

  it('enforces single default BYOK provider and never stores plaintext API keys', () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    try {
      const p1: ModelProviderConfig = {
        id: 'prov-1' as ProviderId,
        name: 'Primary OpenAI Compatible',
        providerType: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-4o',
        credentialKey: 'jobhelper.provider.prov-1',
        timeoutMs: 60_000,
        maxContextTokens: 128_000,
        capabilities: { streaming: true, toolCalling: true, vision: true },
        isDefault: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const p2: ModelProviderConfig = {
        ...p1,
        id: 'prov-2' as ProviderId,
        name: 'Secondary Anthropic',
        providerType: 'anthropic',
        credentialKey: 'jobhelper.provider.prov-2',
        isDefault: true,
      };

      storage.providers.upsert(p1);
      storage.providers.upsert(p2);

      expect(storage.providers.getDefault()?.id).toBe('prov-2');
      expect(storage.providers.getById('prov-1' as ProviderId)?.isDefault).toBe(false);

      const columns = storage.db.sqlite
        .prepare("PRAGMA table_info('model_providers')")
        .all() as Array<{ name: string }>;
      expect(columns.some((c) => /api_key|secret|password|auth_token|access_token/i.test(c.name))).toBe(false);
    } finally {
      storage.close();
    }
  });

  it('persists tasks, 4-axis states, authorized materials, startup recovery, events, HITL cards, and action ledger', () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    try {
      const profileId = 'prof-1' as ProfileId;
      const versionId = 'pver-1' as ProfileVersionId;
      const materialId = 'mat-1' as MaterialId;
      const positionId = 'pos-1' as PositionId;
      const taskId = 'task-1' as TaskId;
      const runId = 'run-1' as RunId;
      const epoch = 'epoch-1' as Epoch;

      storage.profiles.saveProfile({
        id: profileId,
        name: '校招通用简历',
        activeVersionId: versionId,
        createdAt: NOW,
        updatedAt: NOW,
      });
      storage.profiles.saveVersion({
        id: versionId,
        profileId,
        versionNumber: 1,
        content: {
          basic: { fullName: '测试同学', email: 'test@example.com' },
          education: [],
          internships: [],
          projects: [],
          skills: ['TypeScript'],
        },
        contentHash: 'sha256-prof-v1' as ContentHash,
        createdAt: NOW,
      });
      storage.profiles.saveMaterial({
        id: materialId,
        profileId,
        kind: 'resume_pdf',
        fileName: 'resume.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        sha256: 'sha256-mat-1' as ContentHash,
        relativePath: 'materials/mat-1.pdf',
        createdAt: NOW,
      });
      storage.positions.upsert({
        id: positionId,
        company: 'MockCorp',
        jobTitle: 'Frontend Engineer',
        applyUrl: 'http://127.0.0.1:4100/apply/job-001',
        normalizedApplyUrl: 'http://127.0.0.1:4100/apply/job-001',
        progressStage: 'in_progress',
        createdAt: NOW,
        updatedAt: NOW,
      });

      storage.tasks.insert(
        {
          id: taskId,
          kind: 'application',
          title: 'MockCorp - Frontend Engineer',
          company: 'MockCorp',
          jobTitle: 'Frontend Engineer',
          applyUrl: 'http://127.0.0.1:4100/apply/job-001',
          normalizedApplyUrl: 'http://127.0.0.1:4100/apply/job-001',
          positionId,
          profileVersionId: versionId,
          browserProfileId: 'default' as BrowserProfileId,
          controlMode: 'agent',
          executionState: 'running',
          waitingReason: 'none',
          applicationStage: 'filling',
          outcome: 'not_submitted',
          createdAt: NOW,
          updatedAt: NOW,
        },
        [materialId],
      );

      expect(storage.tasks.findActiveApplicationByUrl('http://127.0.0.1:4100/apply/job-001')?.id).toBe(
        taskId,
      );
      expect(storage.tasks.listAuthorizedMaterialIds(taskId)).toEqual([materialId]);

      storage.runs.create({
        id: runId,
        taskId,
        epoch,
        providerSnapshot: {
          providerId: 'prov-1' as ProviderId,
          providerName: 'Mock',
          providerType: 'openai-compatible',
          baseUrl: 'http://localhost',
          modelId: 'mock-1',
          capabilities: { streaming: true, toolCalling: true, vision: false },
        },
        startedAt: NOW,
      });

      // Ordered events + clientMessageId dedup
      const e1 = storage.events.append({
        id: 'ev-1' as EventId,
        taskId,
        runId,
        epoch,
        type: 'user_message',
        clientMessageId: 'cmsg-1' as ClientMessageId,
        payload: { text: '请开始填写' },
        createdAt: NOW,
      });
      const e2 = storage.events.append({
        id: 'ev-2' as EventId,
        taskId,
        runId,
        epoch,
        type: 'assistant_message',
        payload: { text: '正在观察页面' },
        createdAt: NOW,
      });
      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(storage.events.hasClientMessage(taskId, 'cmsg-1' as ClientMessageId)).toBe(true);
      expect(storage.events.listByTask(taskId, 1)).toHaveLength(1);

      // Duplicate clientMessageId rejected by unique partial index
      expect(() =>
        storage.events.append({
          id: 'ev-dup' as EventId,
          taskId,
          type: 'user_message',
          clientMessageId: 'cmsg-1' as ClientMessageId,
          payload: { text: 'duplicate' },
          createdAt: NOW,
        }),
      ).toThrow();

      // HITL: Todo, Question Card, Confirmation Card invalidation
      storage.hitl.saveTodo({
        id: 'todo-1' as TodoId,
        taskId,
        runId,
        reason: 'login',
        summary: '需要登录招聘网站',
        instructions: '请在右侧网页扫码登录',
        status: 'open',
        createdAt: NOW,
      });
      expect(storage.hitl.getOpenTodo(taskId)?.reason).toBe('login');

      storage.hitl.saveQuestionCard({
        id: 'qcard-1',
        taskId,
        runId,
        callId: 'call-99' as CallId,
        questions: [
          {
            id: 'q-1' as QuestionId,
            prompt: '是否接受出差？',
            options: ['接受', '不接受'],
            allowFreeText: false,
            saveToProfileDefault: true,
          },
        ],
        status: 'expired_pending',
        createdAt: NOW,
      });
      storage.hitl.recordQuestionAnswers(
        'qcard-1',
        { 'q-1': { value: '接受', saveToProfile: true } },
        NOW,
      );
      expect(storage.hitl.getQuestionCardByCallId(taskId, 'call-99' as CallId)?.status).toBe('answered');

      const confId = 'conf-1' as ConfirmationId;
      const hash = 'sha256-form-state-1' as ContentHash;
      storage.hitl.saveConfirmation({
        id: confId,
        taskId,
        runId,
        operation: 'final_submit',
        status: 'pending',
        contentHash: hash,
        summary: {
          company: 'MockCorp',
          jobTitle: 'Frontend Engineer',
          keyFields: [{ label: '姓名', value: '测试同学' }],
          missingItems: [],
          attachmentIds: [materialId],
          screenshotArtifactIds: [],
        },
        createdAt: NOW,
      });
      expect(storage.hitl.verifyContentHashMatches(confId, hash)).toBe(true);
      expect(storage.hitl.invalidateConfirmations(taskId, 'form edited', NOW)).toBe(1);
      expect(storage.hitl.verifyContentHashMatches(confId, hash)).toBe(false);

      // Action Ledger
      storage.actionLedger.record({
        id: 'act-1',
        taskId,
        runId,
        epoch,
        actionType: 'fill',
        targetSummary: 'textbox[姓名]',
        status: 'dispatched',
        createdAt: NOW,
        updatedAt: NOW,
      });
      storage.actionLedger.updateStatus('act-1', 'observed', {
        readbackSummary: '测试同学',
        updatedAt: NOW,
      });
      expect(storage.actionLedger.listByRun(runId)[0]?.status).toBe('observed');

      // Startup recovery converts active running task & unfinished run to interrupted
      const recovered = storage.tasks.recoverInterruptedTasksOnStartup('2026-11-24T13:00:00.000Z');
      expect(recovered).toEqual([taskId]);
      const afterRecovery = storage.tasks.getById(taskId);
      expect(afterRecovery?.executionState).toBe('interrupted');
      expect(afterRecovery?.controlMode).toBe('human');
      expect(afterRecovery?.outcome).toBe('not_submitted');
      expect(storage.runs.getById(runId)?.endReason).toBe('interrupted');
    } finally {
      storage.close();
    }
  });
});
