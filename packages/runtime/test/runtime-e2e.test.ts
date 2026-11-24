import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ArtifactId,
  CallId,
  ContentHash,
  Epoch,
  IsoTimestamp,
  ModelProviderConfig,
  ProfileContent,
  ProviderId,
  RunId,
  SessionId,
  TaskId,
} from '@jobhelper/contracts';
import {
  LocalConfirmationService,
  LocalProfileService,
  LocalTaskService,
  TaskControls,
} from '@jobhelper/core';
import type {
  ModelGenerateRequest,
  ModelGenerateResponse,
  ModelRouter,
  ModelTurnMessage,
} from '@jobhelper/model-router';
import { LocalSkillCatalog } from '@jobhelper/skills';
import { createSqliteStorage } from '@jobhelper/storage';
import {
  createApplicationBrowserTools,
  createApplicationBusinessTools,
  createCoordinatorTools,
  DefaultToolRegistry,
} from '@jobhelper/tools';
import {
  InProcessQuestionWaitCoordinator,
  LocalAgentRuntime,
  SlidingWindowContextCompactor,
} from '../src/index.js';

const NOW = '2026-11-24T12:00:00.000Z' as IsoTimestamp;
const REPO_SKILLS_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'skills-library');

const TEST_PROFILE: ProfileContent = {
  basic: { fullName: '林星河', email: 'lin@example.com', city: '上海' },
  education: [],
  internships: [],
  projects: [],
  skills: ['TypeScript', 'React'],
};

const MOCK_PROVIDER: ModelProviderConfig = {
  id: 'prov-mock' as ProviderId,
  name: 'Mock Strong Model',
  providerType: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1/v1',
  modelId: 'mock-tool-model',
  credentialKey: 'key.mock',
  timeoutMs: 5000,
  maxContextTokens: 64_000,
  capabilities: { streaming: true, toolCalling: true, vision: false },
  isDefault: true,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('@jobhelper/runtime M3 Headless End-to-End Loop, Compactor & Question Coordinator', () => {
  it('runs Coordinator dispatch -> Application observe/fill/verify/question/confirmation loop with attention lock and context compaction', async () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    try {
      const leases = new TaskControls();
      const profiles = new LocalProfileService(storage.uow, storage.profiles, storage.preferences);
      const confirmations = new LocalConfirmationService(storage.uow, storage.hitl, storage.events);
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

      const skills = new LocalSkillCatalog(REPO_SKILLS_DIR);
      const questionWaiter = new InProcessQuestionWaitCoordinator();
      const { profile } = profiles.createProfile({ name: '前端校招档案', content: TEST_PROFILE });

      // Simulated browser form state
      const formState = { fullName: '', relocate: '' };
      let obsGen = 0;

      const registry = new DefaultToolRegistry();
      registry.registerAll(
        createCoordinatorTools({
          getCareerOverview: () => ({
            defaultProfileId: profiles.getDefaultProfileId(),
            profiles: profiles.listProfiles(),
            positionsCount: storage.positions.listAll().length,
            activeApplicationsCount: storage.tasks.listAll().filter((t) => t.kind === 'application').length,
          }),
          readProfile: (pid) => {
            const id = pid ?? profiles.getDefaultProfileId();
            if (!id) return null;
            const res = profiles.getProfileWithActiveVersion(id);
            return res ? { ...res, facts: profiles.listFacts(id) } : null;
          },
          editProfile: ({ profileId, nextContent }) => profiles.updateProfileContent(profileId, nextContent),
          listMaterials: () => [],
          readMaterial: async () => {
            throw new Error('no material');
          },
          rememberUserInfo: (i) => profiles.rememberFact({ ...i, source: 'agent_confirmed' }),
          addTrackedPosition: () => {
            throw new Error('unused');
          },
          updateProgress: () => {},
          startApplication: (input) => taskService.startApplication(input),
          listApplicationTasks: () => storage.tasks.listAll().filter((t) => t.kind === 'application'),
        }),
      );

      registry.registerAll(
        createApplicationBrowserTools({
          observe: async () => {
            obsGen++;
            return {
              tabId: 'tab-1' as never,
              url: 'http://127.0.0.1:4100/apply/job-001',
              title: 'MockCorp Apply',
              generation: obsGen,
              truncated: false,
              nodes: [
                { ref: `tab-1:e${obsGen}_1`, role: 'textbox', name: '姓名', value: formState.fullName },
                { ref: `tab-1:e${obsGen}_2`, role: 'textbox', name: '是否接受出差', value: formState.relocate },
                { ref: `tab-1:e${obsGen}_3`, role: 'button', name: '提交申请' },
                // Add padding text to exercise snapshot compaction in later turns
                { role: 'staticText', name: '说明'.repeat(120) },
              ],
            };
          },
          act: async (cmd) => {
            if (cmd.action === 'fill' && cmd.ref?.endsWith('_1')) {
              formState.fullName = cmd.value ?? '';
              return { ok: true, changed: true, readbackValue: formState.fullName };
            }
            if (cmd.action === 'fill' && cmd.ref?.endsWith('_2')) {
              formState.relocate = cmd.value ?? '';
              return { ok: true, changed: true, readbackValue: formState.relocate };
            }
            return { ok: false, error: 'unexpected action' };
          },
          captureScreenshot: async () => ({
            artifactId: 'art-shot-1' as ArtifactId,
            width: 1280,
            height: 800,
            sha256: 'sha256-shot' as ContentHash,
          }),
          listTabs: () => [],
          selectTab: () => {},
          openTab: async () => {
            throw new Error('unused');
          },
          closeTab: async () => {},
          inspectControl: async () => ({ tagName: 'INPUT' }),
          listNetworkEvents: async () => [],
          readSpill: async () => ({ content: '', nextOffset: null }),
          runReadOnlyProbe: async () => ({ errors: [] }),
        }),
      );

      registry.registerAll(
        createApplicationBusinessTools(
          {
            getLockedProfile: (vid) => {
              const snap = profiles.getSnapshot(vid);
              return snap ? { snapshot: snap, facts: profiles.listFacts(snap.profileId) } : null;
            },
            readAuthorizedMaterial: async () => {
              throw new Error('unused');
            },
            askUserQuestion: async ({ taskId, runId, callId, questions }) => {
              // Simulate user answering promptly on live callId
              setTimeout(() => {
                questionWaiter.deliverAnswer(taskId, callId as CallId, [
                  { questionId: questions[0]!.id, value: '接受出差', saveToProfile: true },
                ]);
              }, 10);
              const waited = await questionWaiter.awaitAnswer(
                taskId,
                callId as CallId,
                500,
                new AbortController().signal,
              );
              if (waited.timedOut || !waited.answers) {
                return { status: 'pending' };
              }
              return {
                status: 'answered',
                answers: Object.fromEntries(waited.answers.map((a) => [a.questionId, a.value])),
              };
            },
            requestUserAction: async () => ({ todoId: 'todo-1' }),
            reportFillingReady: async ({ taskId }) => {
              taskService.transitionState({
                taskId,
                next: { applicationStage: 'filling_ready' },
                reason: 'filling_ready',
                actor: 'agent',
              });
            },
            requestSubmissionConfirmation: async (input) => {
              const card = confirmations.createConfirmation({
                taskId: input.taskId,
                runId: input.runId,
                operation: 'final_submit',
                contentHash: input.contentHash,
                summary: {
                  company: input.company,
                  jobTitle: input.jobTitle,
                  keyFields: input.keyFields,
                  missingItems: input.missingItems,
                  attachmentIds: input.attachmentIds,
                  screenshotArtifactIds: input.screenshotArtifactIds,
                  instructions: input.instructions,
                },
              });
              taskService.transitionState({
                taskId: input.taskId,
                next: {
                  executionState: 'waiting_user',
                  waitingReason: 'submission_confirmation',
                },
                reason: 'confirmation_requested',
                actor: 'agent',
              });
              return { confirmationId: card.id };
            },
            requestOperationConfirmation: async () => ({ confirmationId: 'op-1' }),
            reportSubmitAttempted: async () => {},
            reportSubmissionResult: async () => ({ outcome: 'unknown', applicationStage: 'verifying' }),
            updateTaskDetails: async () => {},
            rememberUserInfo: async () => ({ factId: 'f-1' }),
            reportJobUnavailable: async () => {},
            searchSiteMemories: () => [],
            saveSiteMemory: (m) => ({
              id: 'm1',
              ...m,
              verified: false,
              createdAt: NOW,
              updatedAt: NOW,
            }),
            listSkills: (filter) =>
              skills.listMetadata(filter).map((s) => ({
                name: s.name,
                description: s.description,
                category: s.category,
              })),
            loadSkill: async (name) => {
              const doc = await skills.loadSkill(name);
              return doc
                ? { name: doc.manifest.name, bodyMarkdown: doc.bodyMarkdown, catalogVersion: doc.catalogVersion }
                : null;
            },
          },
          {
            captureScreenshot: async () => ({
              artifactId: 'art-shot-1' as ArtifactId,
              width: 1280,
              height: 800,
              sha256: 'sha256-shot' as ContentHash,
            }),
          },
        ),
      );

      // Scripted deterministic ModelRouter simulating Coordinator (step 1) & Application (steps 1..5)
      let coordStep = 0;
      let appStep = 0;
      let observedCompactedMessages: ModelTurnMessage[] = [];
      let blockedFollowupResult: string | null = null;

      const fakeRouter: ModelRouter = {
        probe: async () => MOCK_PROVIDER.capabilities,
        generate: async (req: ModelGenerateRequest): Promise<ModelGenerateResponse> => {
          const isCoord = req.tools.some((t) => t.name === 'start_application');
          if (isCoord) {
            coordStep++;
            if (coordStep === 1) {
              return {
                text: '正在为你创建独立投递任务',
                toolCalls: [
                  {
                    callId: 'c_call_1',
                    name: 'start_application',
                    argumentsJson: JSON.stringify({
                      applyUrl: 'http://127.0.0.1:4100/apply/job-001',
                      profileId: profile.id,
                    }),
                  },
                ],
                usage: { inputTokens: 100, outputTokens: 20 },
                finishReason: 'tool_calls',
                streamed: true,
              };
            }
            return {
              text: '已创建独立投递任务，请在任务详情中查看进展。',
              toolCalls: [],
              usage: { inputTokens: 120, outputTokens: 15 },
              finishReason: 'stop',
              streamed: true,
            };
          }

          appStep++;
          observedCompactedMessages = req.messages;
          if (appStep === 1) {
            return {
              text: '',
              toolCalls: [
                { callId: 'a_1', name: 'read_profile', argumentsJson: '{}' },
                { callId: 'a_2', name: 'skill_load', argumentsJson: '{"skillName":"form-controls"}' },
                { callId: 'a_3', name: 'observe', argumentsJson: '{}' },
              ],
              usage: { inputTokens: 200, outputTokens: 40 },
              finishReason: 'tool_calls',
              streamed: true,
            };
          }
          if (appStep === 2) {
            return {
              text: '',
              toolCalls: [
                {
                  callId: 'a_4',
                  name: 'act',
                  argumentsJson: '{"action":"fill","ref":"tab-1:e1_1","value":"林星河"}',
                },
                { callId: 'a_5', name: 'observe', argumentsJson: '{}' },
                {
                  callId: 'a_6',
                  name: 'ask_user_question',
                  argumentsJson: JSON.stringify({
                    questions: [{ id: 'q-relocate', prompt: '是否接受出差？' }],
                  }),
                },
              ],
              usage: { inputTokens: 250, outputTokens: 50 },
              finishReason: 'tool_calls',
              streamed: true,
            };
          }
          if (appStep === 3) {
            return {
              text: '',
              toolCalls: [
                {
                  callId: 'a_7',
                  name: 'act',
                  argumentsJson: '{"action":"fill","ref":"tab-1:e2_2","value":"接受出差"}',
                },
                { callId: 'a_8', name: 'observe', argumentsJson: '{}' },
                {
                  callId: 'a_9',
                  name: 'report_filling_ready',
                  argumentsJson: '{"filledSummary":"姓名与出差意愿均已填完并回读一致"}',
                },
                {
                  callId: 'a_10',
                  name: 'request_submission_confirmation',
                  argumentsJson: JSON.stringify({
                    company: 'MockCorp',
                    jobTitle: 'Frontend Engineer',
                    keyFields: [
                      { label: '姓名', value: '林星河' },
                      { label: '是否接受出差', value: '接受出差' },
                    ],
                    contentHash: 'sha256-ready-v1',
                  }),
                },
                // Attempt an illegal follow-up browser mutation AFTER confirmation -> must be ATTENTION_LOCKED!
                {
                  callId: 'a_11',
                  name: 'act',
                  argumentsJson: '{"action":"click","ref":"tab-1:e3_3"}',
                },
              ],
              usage: { inputTokens: 300, outputTokens: 60 },
              finishReason: 'tool_calls',
              streamed: true,
            };
          }
          return {
            text: '已完成填写并生成核对卡，请在右侧页面确认后提交。',
            toolCalls: [],
            usage: { inputTokens: 100, outputTokens: 20 },
            finishReason: 'stop',
            streamed: true,
          };
        },
      };

      const runtime = new LocalAgentRuntime({
        modelRouter: fakeRouter,
        tools: registry,
        compactor: new SlidingWindowContextCompactor({ keepRecentToolOutputs: 2, compactedMaxChars: 120 }),
        sink: {
          onToolResult: (ev) => {
            if (ev.callId === 'a_11') {
              blockedFollowupResult = ev.result.error?.code ?? null;
            }
          },
        },
      });

      // 1. Run Coordinator to dispatch application
      const coordTask = taskService.createCoordinatorConversation();
      const coordOutcome = await runtime.startRun({
        taskId: coordTask.id,
        runId: crypto.randomUUID() as RunId,
        epoch: crypto.randomUUID() as Epoch,
        sessionId: `conversation-${coordTask.id}` as SessionId,
        role: 'coordinator',
        provider: MOCK_PROVIDER,
        authorizedMaterialIds: [],
        skillCatalogVersion: skills.getCatalogVersion(),
      });
      expect(coordOutcome.endReason).toBe('completed');

      const appTasks = storage.tasks.listAll().filter((t) => t.kind === 'application');
      expect(appTasks).toHaveLength(1);
      const appTask = appTasks[0]!;

      // Create run row in DB so confirmation FK is valid
      const appRunId = crypto.randomUUID() as RunId;
      const appEpoch = leases.acquire(appTask.id);
      storage.runs.create({
        id: appRunId,
        taskId: appTask.id,
        epoch: appEpoch,
        providerSnapshot: {
          providerId: MOCK_PROVIDER.id,
          providerName: MOCK_PROVIDER.name,
          providerType: MOCK_PROVIDER.providerType,
          baseUrl: MOCK_PROVIDER.baseUrl,
          modelId: MOCK_PROVIDER.modelId,
          capabilities: MOCK_PROVIDER.capabilities,
        },
        startedAt: NOW,
      });
      taskService.transitionState({
        taskId: appTask.id,
        next: { executionState: 'running' },
        reason: 'start_app_run',
        actor: 'system',
      });

      // 2. Run Application headless loop
      const appOutcome = await runtime.startRun({
        taskId: appTask.id,
        runId: appRunId,
        epoch: appEpoch,
        sessionId: `application-${appTask.id}` as SessionId,
        role: 'application',
        provider: MOCK_PROVIDER,
        profileVersionId: appTask.profileVersionId,
        authorizedMaterialIds: [],
        skillCatalogVersion: skills.getCatalogVersion(),
      });

      expect(appOutcome.endReason).toBe('waiting_user');
      expect(formState).toEqual({ fullName: '林星河', relocate: '接受出差' });
      expect(blockedFollowupResult).toBe('ATTENTION_LOCKED');

      // Verify four-axis state: filling_ready + waiting_user(submission_confirmation) + NOT submitted!
      const finalTask = storage.tasks.getById(appTask.id)!;
      expect(finalTask.executionState).toBe('waiting_user');
      expect(finalTask.waitingReason).toBe('submission_confirmation');
      expect(finalTask.applicationStage).toBe('filling_ready');
      expect(finalTask.outcome).toBe('not_submitted');

      // Verify context compactor collapsed earlier observe snapshots!
      const compactedObserve = observedCompactedMessages.find(
        (m) => m.role === 'tool' && m.toolName === 'observe' && typeof m.content === 'string' && m.content.includes('已折叠陈旧页面观察快照'),
      );
      expect(compactedObserve).toBeDefined();

      // Verify role isolation: coordinator invoking observe is rejected
      const forbidden = await registry.invoke(
        'observe',
        {},
        {
          taskId: coordTask.id,
          runId: appRunId,
          epoch: appEpoch,
          callId: 'forb-1' as CallId,
          role: 'coordinator',
          authorizedMaterialIds: [],
          attentionLocked: false,
          signal: new AbortController().signal,
        },
      );
      expect(forbidden.ok).toBe(false);
      expect(forbidden.error?.code).toBe('ROLE_FORBIDDEN');
    } finally {
      storage.close();
    }
  });

  it('rejects models without toolCalling capability and resolves question timeout cleanly without consent', async () => {
    const registry = new DefaultToolRegistry();
    const fakeRouter: ModelRouter = {
      probe: async () => ({ streaming: true, toolCalling: false, vision: false }),
      generate: async () => {
        throw new Error('should not be called');
      },
    };
    const runtime = new LocalAgentRuntime({ modelRouter: fakeRouter, tools: registry });
    const outcome = await runtime.startRun({
      taskId: 't-no-tools' as TaskId,
      runId: 'r-1' as RunId,
      epoch: 'e-1' as Epoch,
      sessionId: 'application-t-no-tools' as SessionId,
      role: 'application',
      provider: {
        ...MOCK_PROVIDER,
        capabilities: { streaming: true, toolCalling: false, vision: false },
      },
      authorizedMaterialIds: [],
      skillCatalogVersion: 'v1',
    });
    expect(outcome.endReason).toBe('model_error');
    expect(outcome.error?.code).toBe('UNSUPPORTED_TOOL_CALLING');

    // Question timeout -> { timedOut: true } cleanly, never throws or fabricates answer
    const waiter = new InProcessQuestionWaitCoordinator();
    const waited = await waiter.awaitAnswer(
      't-1' as TaskId,
      'call-timeout' as CallId,
      30,
      new AbortController().signal,
    );
    expect(waited).toEqual({ timedOut: true });
    expect(waiter.deliverAnswer('t-1' as TaskId, 'call-timeout' as CallId, [])).toBe(false);
  });
});
