import { describe, expect, it } from 'vitest';
import type {
  CallId,
  ClientMessageId,
  ContentHash,
  Epoch,
  IsoTimestamp,
  ProfileContent,
  QuestionId,
  RunId,
  TaskId,
} from '@jobhelper/contracts';
import { createSqliteStorage } from '@jobhelper/storage';
import {
  assertValidFourAxisTransition,
  LocalConfirmationService,
  LocalProfileService,
  LocalTaskScheduler,
  LocalTaskService,
  TaskControls,
} from '../src/index.js';

const PROFILE_CONTENT: ProfileContent = {
  basic: { fullName: '测试候选人', email: 'cand@example.com', city: '上海' },
  education: [],
  internships: [],
  projects: [],
  skills: ['TypeScript'],
};

const NOW = '2026-11-24T12:00:00.000Z' as IsoTimestamp;

describe('@jobhelper/core M2 TaskService, Scheduler, ControlLease & ConfirmationService', () => {
  it('enforces 4-axis state machine invariants and rejects illegal transitions', () => {
    // INV-01: filling_ready cannot directly become submitted_verified
    expect(() =>
      assertValidFourAxisTransition(
        {
          executionState: 'running',
          waitingReason: 'none',
          applicationStage: 'filling',
          outcome: 'not_submitted',
        },
        {
          applicationStage: 'filling_ready',
          outcome: 'submitted_verified',
        },
      ),
    ).toThrow(/filling_ready/);

    // INV-08: submit_attempted cannot regress back to filling
    expect(() =>
      assertValidFourAxisTransition(
        {
          executionState: 'waiting_user',
          waitingReason: 'result_check',
          applicationStage: 'submit_attempted',
          outcome: 'unknown',
        },
        {
          applicationStage: 'filling',
        },
      ),
    ).toThrow(/回退/);

    // Terminal outcome cannot be overwritten
    expect(() =>
      assertValidFourAxisTransition(
        {
          executionState: 'waiting_user',
          waitingReason: 'result_check',
          applicationStage: 'done',
          outcome: 'submitted_verified',
        },
        {
          executionState: 'closed',
          outcome: 'closed_without_submit',
        },
      ),
    ).toThrow(/不可覆盖/);
  });

  it('deduplicates concurrent & repeated startApplication by normalized URL, enforces scheduler concurrency, and revokes epoch on takeover', async () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    try {
      const leases = new TaskControls();
      const profiles = new LocalProfileService(storage.uow, storage.profiles, storage.preferences);
      const confirmations = new LocalConfirmationService(storage.uow, storage.hitl, storage.events);

      const { profile: profileA, snapshot: snapA } = profiles.createProfile({
        name: '档案A',
        content: PROFILE_CONTENT,
      });

      const dispatched: Array<{ taskId: TaskId; epoch: Epoch }> = [];
      const scheduler = new LocalTaskScheduler(
        leases,
        {
          onDispatch: async (taskId, epoch) => {
            dispatched.push({ taskId, epoch });
            taskService.transitionState({
              taskId,
              next: { executionState: 'running', waitingReason: 'none' },
              reason: 'dispatched',
              actor: 'system',
            });
          },
        },
        1, // maxConcurrent = 1 to verify FIFO queueing
      );

      const taskService = new LocalTaskService({
        uow: storage.uow,
        tasks: storage.tasks,
        positions: storage.positions,
        events: storage.events,
        hitl: storage.hitl,
        profiles,
        confirmations,
        leases,
        scheduler,
      });

      // Concurrent duplicate startApplication calls with tracking params coalesce & reuse single task
      const [r1, r2] = await Promise.all([
        taskService.startApplication({
          applyUrl: 'https://jobs.example.com/apply/101?utm_source=wechat',
          profileId: profileA.id,
        }),
        taskService.startApplication({
          applyUrl: 'https://jobs.example.com/apply/101/?utm_campaign=campus',
          profileId: profileA.id,
        }),
      ]);
      expect(r1.task.id).toBe(r2.task.id);
      const r3 = await taskService.startApplication({
        applyUrl: 'https://jobs.example.com/apply/101',
      });
      expect(r3.reused).toBe(true);
      expect(r3.task.id).toBe(r1.task.id);

      // Switching global default profile to B does NOT change r1's locked profileVersionId
      const { profile: profileB } = profiles.createProfile({
        name: '档案B',
        content: { ...PROFILE_CONTENT, basic: { fullName: '档案B用户' } },
        setAsDefault: true,
      });
      expect(profiles.getDefaultProfileId()).toBe(profileB.id);
      expect(storage.tasks.getById(r1.task.id)?.profileVersionId).toBe(snapA.id);

      // Second job queues behind first because maxConcurrent = 1
      const job2 = await taskService.startApplication({
        applyUrl: 'https://jobs.example.com/apply/202',
      });
      expect(job2.reused).toBe(false);
      expect(job2.task.profileVersionId).toBe(profileB.activeVersionId);

      await scheduler.drain();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.taskId).toBe(r1.task.id);
      const oldEpoch = dispatched[0]!.epoch;

      // Active epoch passes assertion
      expect(() => leases.assert(r1.task.id, oldEpoch)).not.toThrow();

      // Create a run record + confirmation card, then user requests takeover -> old epoch immediately rejected
      storage.runs.create({
        id: 'run-a' as RunId,
        taskId: r1.task.id,
        epoch: oldEpoch,
        providerSnapshot: {
          providerId: 'p1' as never,
          providerName: 'Mock',
          providerType: 'openai-compatible',
          baseUrl: 'http://localhost',
          modelId: 'm1',
          capabilities: { streaming: true, toolCalling: true, vision: false },
        },
        startedAt: NOW,
      });
      const conf = confirmations.createConfirmation({
        taskId: r1.task.id,
        runId: 'run-a' as RunId,
        operation: 'final_submit',
        contentHash: 'hash-v1' as ContentHash,
        summary: {
          company: 'Example',
          jobTitle: 'SWE',
          keyFields: [{ label: '姓名', value: '测试候选人' }],
          missingItems: [],
          attachmentIds: [],
          screenshotArtifactIds: [],
        },
      });
      confirmations.resolve({
        taskId: r1.task.id,
        confirmationId: conf.id,
        decision: 'approve',
      });

      await taskService.requestTakeover(r1.task.id);
      expect(() => leases.assert(r1.task.id, oldEpoch)).toThrow(/已暂停|过期/);
      expect(storage.tasks.getById(r1.task.id)?.executionState).toBe('paused');
      expect(storage.tasks.getById(r1.task.id)?.controlMode).toBe('human');

      // Resuming after manual takeover invalidates previous confirmation card (INV-07)
      await taskService.resumeAfterCheck(r1.task.id);
      expect(() =>
        confirmations.assertValidAndConsume(
          r1.task.id,
          conf.id,
          'hash-v1' as ContentHash,
          'run-b' as RunId,
        ),
      ).toThrow(/失效|invalidated/);

      // Drain now dispatches job2 (FIFO)
      await scheduler.drain();
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]!.taskId).toBe(job2.task.id);
    } finally {
      storage.close();
    }
  });

  it('handles clientMessageId dedup, late question answers, and startup interrupted recovery', async () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    try {
      const leases = new TaskControls();
      const profiles = new LocalProfileService(storage.uow, storage.profiles, storage.preferences);
      const confirmations = new LocalConfirmationService(storage.uow, storage.hitl, storage.events);
      profiles.createProfile({ name: '默认档案', content: PROFILE_CONTENT });

      const taskService = new LocalTaskService({
        uow: storage.uow,
        tasks: storage.tasks,
        positions: storage.positions,
        events: storage.events,
        hitl: storage.hitl,
        profiles,
        confirmations,
        leases,
      });

      const { task } = await taskService.startApplication({
        applyUrl: 'https://jobs.example.com/apply/303',
      });

      // Duplicate clientMessageId is ignored
      const cmsg = 'client-msg-1' as ClientMessageId;
      expect(await taskService.enqueueUserMessage({ taskId: task.id, clientMessageId: cmsg, text: 'hello' })).toEqual({
        accepted: true,
        duplicated: false,
      });
      expect(await taskService.enqueueUserMessage({ taskId: task.id, clientMessageId: cmsg, text: 'hello' })).toEqual({
        accepted: false,
        duplicated: true,
      });

      // Late answer after question timeout reattaches to original questionId, saves fact, and requeues task
      const runId = 'run-q1' as RunId;
      storage.runs.create({
        id: runId,
        taskId: task.id,
        epoch: 'epoch-q1' as Epoch,
        providerSnapshot: {
          providerId: 'p1' as never,
          providerName: 'Mock',
          providerType: 'openai-compatible',
          baseUrl: 'http://localhost',
          modelId: 'm1',
          capabilities: { streaming: true, toolCalling: true, vision: false },
        },
        startedAt: NOW,
      });
      taskService.transitionState({
        taskId: task.id,
        next: { executionState: 'running' },
        reason: 'start',
        actor: 'system',
      });
      taskService.transitionState({
        taskId: task.id,
        next: { executionState: 'waiting_user', waitingReason: 'missing_info' },
        reason: 'question_timeout',
        actor: 'system',
      });

      const qId = 'q-gpa' as QuestionId;
      storage.hitl.saveQuestionCard({
        id: 'card-gpa',
        taskId: task.id,
        runId,
        callId: 'call-gpa' as CallId,
        questions: [
          {
            id: qId,
            prompt: '本科 GPA',
            allowFreeText: true,
            saveToProfileDefault: true,
          },
        ],
        status: 'expired_pending',
        createdAt: NOW,
      });

      await taskService.answerQuestion({
        taskId: task.id,
        questionCardId: 'card-gpa',
        answers: [{ questionId: qId, value: '3.9/4.0', saveToProfile: true }],
      });

      expect(storage.hitl.getQuestionCard('card-gpa')?.status).toBe('answered');
      expect(storage.tasks.getById(task.id)?.executionState).toBe('queued');
      expect(profiles.listFacts().some((f) => f.key === '本科 GPA' && f.value === '3.9/4.0')).toBe(true);

      // Startup recovery marks queued/running tasks interrupted without replaying actions
      const recovered = taskService.recoverOnStartup();
      expect(recovered).toContain(task.id);
      expect(storage.tasks.getById(task.id)?.executionState).toBe('interrupted');
      expect(storage.tasks.getById(task.id)?.outcome).toBe('not_submitted');
    } finally {
      storage.close();
    }
  });
});
