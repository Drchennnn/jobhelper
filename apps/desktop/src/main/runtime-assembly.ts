import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ArtifactId,
  CallId,
  ContentHash,
  EventId,
  IsoTimestamp,
  PositionId,
  TaskId,
  TodoId,
} from '@jobhelper/contracts';
import type {
  DefaultSubmitHardGuard,
  LocalTaskTabManager,
  ScopedBrowserController,
} from '@jobhelper/browser-bridge';
import {
  normalizeApplyUrl,
  validateBrowserUrl,
  type LocalConfirmationService,
  type LocalMaterialService,
  type LocalProfileService,
  type LocalTaskService,
} from '@jobhelper/core';
import type { LocalTaskMcpServer } from '@jobhelper/mcp-adapter';
import type { ModelRouter } from '@jobhelper/model-router';
import {
  InProcessQuestionWaitCoordinator,
  LocalAgentRuntime,
  type RuntimeEventSink,
} from '@jobhelper/runtime';
import type { LocalSkillCatalog } from '@jobhelper/skills';
import type { SqliteStorage } from '@jobhelper/storage';
import {
  createApplicationBrowserTools,
  createApplicationBusinessTools,
  createCoordinatorTools,
  DefaultToolRegistry,
} from '@jobhelper/tools';

export interface RuntimeAssemblyDeps {
  storage: SqliteStorage;
  taskService: LocalTaskService;
  profiles: LocalProfileService;
  materials: LocalMaterialService;
  confirmations: LocalConfirmationService;
  tabs: LocalTaskTabManager;
  browserController: ScopedBrowserController;
  submitGuard: DefaultSubmitHardGuard;
  modelRouter: ModelRouter;
  skills: LocalSkillCatalog;
  artifactsRootDir: string;
  mcpServer?: LocalTaskMcpServer;
  questionTimeoutMs?: number;
  sink?: RuntimeEventSink;
}

export interface AssembledAgentEngine {
  readonly registry: DefaultToolRegistry;
  readonly questionWaiter: InProcessQuestionWaitCoordinator;
  readonly runtime: LocalAgentRuntime;
}

/**
 * Wires M1–M3 packages (Tools + Skills + QuestionWaiter + Runtime) directly onto the
 * Desktop Main Process domain services and SQLite storage.
 */
export function assembleDesktopAgentEngine(deps: RuntimeAssemblyDeps): AssembledAgentEngine {
  const questionWaiter = new InProcessQuestionWaitCoordinator();
  const registry = new DefaultToolRegistry();
  const consumedUserSeqByTask = new Map<TaskId, number>();

  const captureAndStoreScreenshot = async (
    taskId: TaskId,
    epoch: Parameters<ScopedBrowserController['captureScreenshot']>[1],
    options?: { tabId?: Parameters<ScopedBrowserController['captureScreenshot']>[2] extends infer O ? O extends { tabId?: infer T } ? T : never : never; fullPage?: boolean; label?: string },
  ) => {
    const shot = await deps.browserController.captureScreenshot(taskId, epoch, options);
    const buf = Buffer.from(shot.pngBase64, 'base64');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex') as ContentHash;
    const artifactId = crypto.randomUUID() as ArtifactId;
    const relPath = path.posix.join('artifacts', taskId, `${artifactId}.png`);
    const fullPath = path.resolve(deps.artifactsRootDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, buf);

    deps.storage.artifacts.save({
      id: artifactId,
      taskId,
      kind: options?.label?.includes('确认') ? 'confirmation_screenshot' : 'screenshot',
      mimeType: 'image/png',
      sizeBytes: buf.byteLength,
      sha256,
      relativePath: relPath,
      label: options?.label,
      createdAt: new Date().toISOString() as IsoTimestamp,
    });
    return { artifactId, width: shot.width, height: shot.height, sha256 };
  };

  registry.registerAll(
    createCoordinatorTools({
      getCareerOverview: () => ({
        defaultProfileId: deps.profiles.getDefaultProfileId(),
        profiles: deps.profiles.listProfiles(),
        positionsCount: deps.storage.positions.listAll().length,
        activeApplicationsCount: deps.storage.tasks
          .listAll()
          .filter((t) => t.kind === 'application' && t.executionState !== 'closed').length,
      }),
      readProfile: (profileId) => {
        const id = profileId ?? deps.profiles.getDefaultProfileId();
        if (!id) return null;
        const active = deps.profiles.getProfileWithActiveVersion(id);
        return active ? { ...active, facts: deps.profiles.listFacts(id) } : null;
      },
      editProfile: ({ profileId, nextContent }) =>
        deps.profiles.updateProfileContent(profileId, nextContent),
      listMaterials: (profileId) =>
        deps.materials.listMaterials(profileId).map((m) => ({
          id: m.id,
          fileName: m.fileName,
          kind: m.kind,
          sizeBytes: m.sizeBytes,
        })),
      readMaterial: async (materialId, offset, limit) => {
        const slice = deps.materials.readTextSlice({ materialId, offset, limit });
        return {
          fileName: slice.fileName,
          mimeType: slice.mimeType,
          content: slice.content,
          nextOffset: slice.nextOffset,
        };
      },
      rememberUserInfo: (input) => deps.profiles.rememberFact({ ...input, source: 'agent_confirmed' }),
      addTrackedPosition: (input) => {
        const validUrl = validateBrowserUrl(input.applyUrl);
        const normalized = normalizeApplyUrl(validUrl);
        const existing = deps.storage.positions.findByNormalizedUrl(normalized);
        if (existing) return existing;
        const now = new Date().toISOString() as IsoTimestamp;
        const pos = {
          id: crypto.randomUUID() as PositionId,
          company: input.company,
          jobTitle: input.jobTitle,
          applyUrl: validUrl,
          normalizedApplyUrl: normalized,
          sourceNote: input.sourceNote,
          progressStage: 'saved' as const,
          createdAt: now,
          updatedAt: now,
        };
        deps.storage.positions.upsert(pos);
        return pos;
      },
      updateProgress: (input) => {
        deps.storage.positions.updateProgress(input.positionId, input.stage, {
          closedReason: input.closedReason,
          notes: input.notes,
        });
      },
      startApplication: async (input) => {
        const res = await deps.taskService.startApplication(input);
        if (!res.reused && res.task.applyUrl && deps.tabs.listTabs(res.task.id).length === 0) {
          await deps.tabs.createTab(res.task.id, res.task.applyUrl, res.task.browserProfileId);
        }
        return res;
      },
      listApplicationTasks: (taskIds) => {
        const all = deps.storage.tasks.listAll().filter((t) => t.kind === 'application');
        if (!taskIds || taskIds.length === 0) return all;
        const set = new Set(taskIds);
        return all.filter((t) => set.has(t.id));
      },
    }),
  );

  registry.registerAll(
    createApplicationBrowserTools({
      observe: (taskId, epoch, tabId) => deps.browserController.observe(taskId, epoch, tabId),
      act: (command) => deps.browserController.act(command),
      captureScreenshot: captureAndStoreScreenshot,
      listTabs: (taskId) => deps.tabs.listTabs(taskId),
      selectTab: (taskId, tabId) => deps.tabs.selectTab(taskId, tabId),
      openTab: async (taskId, url) => {
        const task = deps.storage.tasks.getById(taskId);
        if (!task) throw new Error(`任务不存在: ${taskId}`);
        return deps.tabs.createTab(taskId, url, task.browserProfileId);
      },
      closeTab: (taskId, tabId) => deps.tabs.closeTab(taskId, tabId),
      inspectControl: async (_taskId, _epoch, ref) => ({ ref, status: 'inspected' }),
      listNetworkEvents: async () => [],
      readSpill: async () => ({ content: '', nextOffset: null }),
      runReadOnlyProbe: async (_taskId, _epoch, probe) => {
        const decision = deps.submitGuard.evaluateScriptProbe(probe);
        if (!decision.allowed) throw new Error(decision.reason);
        return { probe, ok: true };
      },
    }),
  );

  registry.registerAll(
    createApplicationBusinessTools(
      {
        getLockedProfile: (versionId) => {
          const snapshot = deps.profiles.getSnapshot(versionId);
          if (!snapshot) return null;
          return { snapshot, facts: deps.profiles.listFacts(snapshot.profileId) };
        },
        readAuthorizedMaterial: async (materialId, authorizedMaterialIds, offset, limit) => {
          const slice = deps.materials.readTextSlice({
            materialId,
            authorizedMaterialIds,
            offset,
            limit,
          });
          return {
            fileName: slice.fileName,
            mimeType: slice.mimeType,
            content: slice.content,
            nextOffset: slice.nextOffset,
          };
        },
        askUserQuestion: async ({ taskId, runId, callId, questions }) => {
          const now = new Date().toISOString() as IsoTimestamp;
          const cardId = crypto.randomUUID();
          deps.storage.hitl.saveQuestionCard({
            id: cardId,
            taskId,
            runId,
            callId: callId as CallId,
            questions,
            status: 'pending',
            createdAt: now,
          });
          deps.storage.events.append({
            id: crypto.randomUUID() as EventId,
            taskId,
            runId,
            type: 'question_asked',
            payload: { questionCardId: cardId, callId, questions },
            createdAt: now,
          });
          const waited = await questionWaiter.awaitAnswer(
            taskId,
            callId as CallId,
            deps.questionTimeoutMs ?? 120_000,
            new AbortController().signal,
          );
          if (waited.timedOut || !waited.answers) {
            deps.storage.hitl.saveQuestionCard({
              id: cardId,
              taskId,
              runId,
              callId: callId as CallId,
              questions,
              status: 'expired_pending',
              createdAt: now,
            });
            deps.taskService.transitionState({
              taskId,
              next: { executionState: 'waiting_user', waitingReason: 'missing_info' },
              reason: 'question_timed_out_pending',
              actor: 'agent',
            });
            return { status: 'pending' };
          }
          return {
            status: 'answered',
            answers: Object.fromEntries(waited.answers.map((a) => [a.questionId, a.value])),
          };
        },
        requestUserAction: async ({ taskId, runId, reason, summary, instructions }) => {
          const now = new Date().toISOString() as IsoTimestamp;
          const todoId = crypto.randomUUID() as TodoId;
          deps.storage.hitl.saveTodo({
            id: todoId,
            taskId,
            runId,
            reason,
            summary,
            instructions,
            status: 'open',
            createdAt: now,
          });
          deps.storage.events.append({
            id: crypto.randomUUID() as EventId,
            taskId,
            runId,
            type: 'todo_updated',
            payload: { todoId, reason, summary, instructions, status: 'open' },
            createdAt: now,
          });
          deps.taskService.transitionState({
            taskId,
            next: { executionState: 'waiting_user', waitingReason: reason },
            reason: `agent_requested_user_action:${reason}`,
            actor: 'agent',
          });
          return { todoId };
        },
        reportFillingReady: async ({ taskId }) => {
          deps.taskService.transitionState({
            taskId,
            next: { applicationStage: 'filling_ready' },
            reason: 'agent_reported_filling_ready',
            actor: 'agent',
          });
        },
        requestSubmissionConfirmation: async (input) => {
          const card = deps.confirmations.createConfirmation({
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
          deps.taskService.transitionState({
            taskId: input.taskId,
            next: {
              executionState: 'waiting_user',
              waitingReason: 'submission_confirmation',
              applicationStage: 'filling_ready',
            },
            reason: 'submission_confirmation_requested',
            actor: 'agent',
          });
          return { confirmationId: card.id };
        },
        requestOperationConfirmation: async (input) => {
          const card = deps.confirmations.createConfirmation({
            taskId: input.taskId,
            runId: input.runId,
            operation: input.operation,
            contentHash: input.contentHash,
            summary: {
              keyFields: [],
              missingItems: [],
              attachmentIds: [],
              screenshotArtifactIds: [],
              instructions: input.summary,
            },
          });
          deps.taskService.transitionState({
            taskId: input.taskId,
            next: { executionState: 'waiting_user', waitingReason: 'manual_control' },
            reason: `operation_confirmation:${input.operation}`,
            actor: 'agent',
          });
          return { confirmationId: card.id };
        },
        reportSubmitAttempted: async ({ taskId, source, evidenceNote }) => {
          deps.taskService.transitionState({
            taskId,
            next: {
              applicationStage: 'submit_attempted',
              outcome: 'unknown',
            },
            reason: `submit_attempted:${source}:${evidenceNote}`,
            actor: 'agent',
          });
        },
        reportSubmissionResult: async ({ taskId, verified, receiptText }) => {
          if (verified) {
            const updated = deps.taskService.transitionState({
              taskId,
              next: {
                executionState: 'closed',
                waitingReason: 'none',
                applicationStage: 'done',
                outcome: 'submitted_verified',
              },
              reason: `receipt_verified:${receiptText ?? ''}`,
              actor: 'agent',
            });
            if (updated.positionId) {
              deps.storage.positions.updateProgress(updated.positionId, 'submitted_verified');
            }
            return { outcome: updated.outcome, applicationStage: updated.applicationStage };
          }
          const verifying = deps.taskService.transitionState({
            taskId,
            next: {
              executionState: 'waiting_user',
              waitingReason: 'result_check',
              applicationStage: 'verifying',
              outcome: 'unknown',
            },
            reason: 'receipt_unverified_needs_check',
            actor: 'agent',
          });
          return { outcome: verifying.outcome, applicationStage: verifying.applicationStage };
        },
        updateTaskDetails: async ({ taskId, company, jobTitle }) => {
          const task = deps.storage.tasks.getById(taskId);
          if (!task) return;
          const nextCompany = company ?? task.company;
          const nextJob = jobTitle ?? task.jobTitle;
          deps.storage.tasks.update({
            ...task,
            company: nextCompany,
            jobTitle: nextJob,
            title: nextCompany && nextJob ? `${nextCompany} - ${nextJob}` : task.title,
            updatedAt: new Date().toISOString() as IsoTimestamp,
          });
        },
        rememberUserInfo: async ({ taskId, key, value }) => {
          const task = deps.storage.tasks.getById(taskId);
          const snap = task?.profileVersionId ? deps.profiles.getSnapshot(task.profileVersionId) : null;
          const fact = deps.profiles.rememberFact({
            scope: snap ? 'profile' : 'global',
            profileId: snap?.profileId,
            key,
            value,
            source: 'agent_confirmed',
          });
          return { factId: fact.id };
        },
        reportJobUnavailable: async ({ taskId, reason }) => {
          deps.taskService.transitionState({
            taskId,
            next: {
              executionState: 'closed',
              waitingReason: 'none',
              applicationStage: 'done',
              outcome: 'job_unavailable',
            },
            reason: `job_unavailable:${reason}`,
            actor: 'agent',
          });
        },
        searchSiteMemories: (domain) => deps.storage.siteMemories.listByDomain(domain),
        saveSiteMemory: ({ domain, title, content }) => {
          const now = new Date().toISOString() as IsoTimestamp;
          const record = {
            id: crypto.randomUUID(),
            domain,
            title,
            content,
            verified: false,
            createdAt: now,
            updatedAt: now,
          };
          deps.storage.siteMemories.upsert(record);
          return record;
        },
        listSkills: (filter) =>
          deps.skills.listMetadata(filter).map((s) => ({
            name: s.name,
            description: s.description,
            category: s.category,
          })),
        loadSkill: async (skillName) => {
          const doc = await deps.skills.loadSkill(skillName);
          return doc
            ? {
                name: doc.manifest.name,
                bodyMarkdown: doc.bodyMarkdown,
                catalogVersion: doc.catalogVersion,
              }
            : null;
        },
      },
      { captureScreenshot: captureAndStoreScreenshot },
    ),
  );

  const runtime = new LocalAgentRuntime({
    modelRouter: deps.modelRouter,
    tools: registry,
    getPendingUserPrompts: (taskId) => {
      const afterSeq = consumedUserSeqByTask.get(taskId) ?? 0;
      const events = deps.storage.events.listByTask(taskId, afterSeq);
      const prompts: string[] = [];
      let maxSeq = afterSeq;
      for (const ev of events) {
        if (ev.seq > maxSeq) maxSeq = ev.seq;
        if (ev.type === 'user_message' && typeof ev.payload.text === 'string' && ev.payload.text.trim()) {
          prompts.push(ev.payload.text.trim());
        } else if (ev.type === 'question_answered') {
          const answers = ev.payload.answers as Array<{ questionId: string; value: string }> | undefined;
          if (answers && answers.length > 0) {
            prompts.push(
              `用户已补答先前问题卡（callId=${String(ev.payload.callId ?? '')}）：${JSON.stringify(answers)}`,
            );
          }
        }
      }
      consumedUserSeqByTask.set(taskId, maxSeq);
      return prompts;
    },
    sink: {
      onStreamDelta: (delta) => deps.sink?.onStreamDelta?.(delta),
      onAssistantMessage: (ev) => {
        deps.storage.events.append({
          id: crypto.randomUUID() as EventId,
          taskId: ev.taskId,
          runId: ev.runId,
          epoch: ev.epoch,
          type: 'assistant_message',
          payload: { text: ev.text, reasoning: ev.reasoning, partial: ev.partial },
          createdAt: ev.createdAt,
        });
        deps.sink?.onAssistantMessage?.(ev);
      },
      onToolCall: (ev) => {
        deps.storage.events.append({
          id: crypto.randomUUID() as EventId,
          taskId: ev.taskId,
          runId: ev.runId,
          epoch: ev.epoch,
          type: 'tool_call',
          payload: { callId: ev.callId, toolName: ev.toolName, argumentsJson: ev.argumentsJson },
          createdAt: ev.createdAt,
        });
        deps.sink?.onToolCall?.(ev);
      },
      onToolResult: (ev) => {
        deps.storage.events.append({
          id: crypto.randomUUID() as EventId,
          taskId: ev.taskId,
          runId: ev.runId,
          epoch: ev.epoch,
          type: 'tool_result',
          payload: { callId: ev.callId, toolName: ev.toolName, result: ev.result },
          createdAt: ev.createdAt,
        });
        deps.sink?.onToolResult?.(ev);
      },
    },
  });

  return { registry, questionWaiter, runtime };
}
