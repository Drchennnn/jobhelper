import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Epoch,
  EventId,
  IsoTimestamp,
  MainToRendererEvent,
  RunId,
  SessionId,
  TaskId,
} from '@jobhelper/contracts';
import {
  DefaultSubmitHardGuard,
  LocalScopedCdpBridge,
  LocalTaskTabManager,
  ScopedBrowserController,
  type WebContentsViewFactory,
} from '@jobhelper/browser-bridge';
import {
  LocalConfirmationService,
  LocalMaterialService,
  LocalProfileService,
  LocalTaskScheduler,
  LocalTaskService,
  TaskControls,
} from '@jobhelper/core';
import { LocalTaskMcpServer } from '@jobhelper/mcp-adapter';
import { ByokModelRouter, type CredentialStore } from '@jobhelper/model-router';
import { LocalSkillCatalog } from '@jobhelper/skills';
import { createSqliteStorage, type SqliteStorage } from '@jobhelper/storage';
import { DesktopIpcRouter } from './ipc-router.js';
import { assembleDesktopAgentEngine, type AssembledAgentEngine } from './runtime-assembly.js';
import { WorkerProcessSupervisor, type WorkerChildTransport } from './worker-supervisor.js';

const DEFAULT_BUILTIN_SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'skills-library',
);

export interface DesktopKernelOptions {
  dbPath: string;
  materialsRootDir: string;
  artifactsRootDir?: string;
  builtinSkillsDir?: string;
  credentials: CredentialStore;
  viewFactory: WebContentsViewFactory;
  spawnWorker: () => WorkerChildTransport;
  workbenchOrigin?: string;
  maxConcurrent?: number;
  stopAckTimeoutMs?: number;
  enableLocalMcpServer?: boolean;
  onEmitRendererEvent?: (event: MainToRendererEvent) => void;
  onDetachWindow?: (taskId: TaskId) => Promise<void> | void;
}

export interface DesktopMainKernel {
  readonly storage: SqliteStorage;
  readonly leases: TaskControls;
  readonly profiles: LocalProfileService;
  readonly materials: LocalMaterialService;
  readonly confirmations: LocalConfirmationService;
  readonly submitGuard: DefaultSubmitHardGuard;
  readonly tabs: LocalTaskTabManager;
  readonly cdpBridge: LocalScopedCdpBridge;
  readonly browserController: ScopedBrowserController;
  readonly modelRouter: ByokModelRouter;
  readonly skills: LocalSkillCatalog;
  readonly mcpServer: LocalTaskMcpServer;
  readonly agentEngine: AssembledAgentEngine;
  readonly scheduler: LocalTaskScheduler;
  readonly taskService: LocalTaskService;
  readonly worker: WorkerProcessSupervisor;
  readonly ipcRouter: DesktopIpcRouter;
  start(): { recoveredTaskIds: TaskId[] };
  shutdown(): Promise<void>;
}

/**
 * Main Process composition root uniting Storage, Core Services, Leases, Scoped CDP,
 * Submit Hard-Guard, BYOK ModelRouter, Skills Catalog (Option A), Unified ToolRegistry,
 * AgentRuntime, Optional Task MCP Server, Worker Supervisor, and Typed IPC Router.
 */
export function createDesktopMainKernel(options: DesktopKernelOptions): DesktopMainKernel {
  const storage = createSqliteStorage({ filename: options.dbPath });
  const leases = new TaskControls();
  const profiles = new LocalProfileService(storage.uow, storage.profiles, storage.preferences);
  const materials = new LocalMaterialService(storage.uow, storage.profiles, {
    rootDir: options.materialsRootDir,
  });
  const confirmations = new LocalConfirmationService(storage.uow, storage.hitl, storage.events);
  const submitGuard = new DefaultSubmitHardGuard({ mode: 'manual_only' });
  const modelRouter = new ByokModelRouter(storage.providers, options.credentials);

  const savedExternalDirs = storage.preferences.get<string[]>('externalSkillDirs') ?? [];
  const skills = new LocalSkillCatalog(
    options.builtinSkillsDir ?? DEFAULT_BUILTIN_SKILLS_DIR,
    savedExternalDirs,
  );
  const savedMaxConcurrent = storage.preferences.get<number>('maxConcurrent');

  let cdpBridge!: LocalScopedCdpBridge;
  let taskService!: LocalTaskService;
  let worker!: WorkerProcessSupervisor;

  const tabs = new LocalTaskTabManager({
    viewFactory: options.viewFactory,
    workbenchOrigin: options.workbenchOrigin,
    onTabAdded: (tab) => {
      void cdpBridge.notifyTabAdded(tab);
    },
    onTabRemoved: (tab) => {
      cdpBridge.notifyTabRemoved(tab);
    },
    onRendererGone: (taskId) => {
      void taskService.requestTakeover(taskId);
    },
  });

  cdpBridge = new LocalScopedCdpBridge({
    getTabs: (taskId) => tabs.getManagedTabs(taskId),
    assertActive: (taskId, epoch) => leases.assert(taskId, epoch),
    createTab: async (taskId, url) => {
      const task = storage.tasks.getById(taskId);
      if (!task) throw new Error(`任务不存在: ${taskId}`);
      const info = await tabs.createTab(taskId, url, task.browserProfileId);
      const managed = tabs.getManagedTabs(taskId).find((t) => t.id === info.id);
      if (!managed) throw new Error('新建标签页不可用');
      return managed;
    },
    selectTab: (taskId, tabId) => tabs.selectTab(taskId, tabId),
    closeTab: (taskId, tabId) => tabs.closeTab(taskId, tabId),
    workbenchOrigin: options.workbenchOrigin,
  });

  const browserController = new ScopedBrowserController({
    tabs,
    assertActive: (taskId, epoch) => leases.assert(taskId, epoch),
    submitGuard,
    workbenchOrigin: options.workbenchOrigin,
    resolveAuthorizedFilePath: (taskId, materialId) => {
      const authorized = storage.tasks.listAuthorizedMaterialIds(taskId);
      const { record, filePath } = materials.resolveAuthorizedFilePath(materialId, authorized);
      return { filePath, fileName: record.fileName };
    },
  });

  let agentEngine!: AssembledAgentEngine;

  worker = new WorkerProcessSupervisor({
    leases,
    spawnWorker: options.spawnWorker,
    onRevokeCdp: (taskId) => cdpBridge.revokeTask(taskId),
    stopAckTimeoutMs: options.stopAckTimeoutMs,
    onStreamDelta: (delta) => {
      options.onEmitRendererEvent?.({ type: 'stream_delta', taskId: delta.taskId, delta });
    },
    onRpcRequest: async (taskId, epoch, method) => {
      if (method === 'cdp_connect') {
        return { wsEndpoint: await cdpBridge.issueEndpoint(taskId, epoch) };
      }
      throw new Error(`未实现的 Worker RPC 方法: ${method}`);
    },
    onRunFinished: (ev) => {
      const task = storage.tasks.getById(ev.taskId);
      if (!task || task.executionState === 'closed') return;
      if (ev.endReason === 'model_error' || ev.endReason === 'browser_error') {
        storage.events.append({
          id: crypto.randomUUID() as EventId,
          taskId: ev.taskId,
          runId: ev.runId,
          epoch: ev.epoch,
          type: 'system_notice',
          payload: {
            kind: ev.endReason,
            message: ev.error ?? '本轮执行出现错误，请检查模型配置或网页状态后继续。',
          },
          createdAt: new Date().toISOString() as IsoTimestamp,
        });
        if (task.executionState === 'running') {
          taskService.transitionState({
            taskId: ev.taskId,
            next: { executionState: 'error', waitingReason: 'manual_control' },
            reason: ev.endReason,
            actor: 'system',
          });
        }
      } else if (ev.endReason === 'completed' && task.executionState === 'running') {
        // Normal turn end returns control to human without ever assuming submission succeeded (INV-01)
        taskService.transitionState({
          taskId: ev.taskId,
          next:
            task.kind === 'coordinator'
              ? { executionState: 'draft', waitingReason: 'none' }
              : { executionState: 'paused', waitingReason: 'manual_control' },
          reason: 'run_completed_idle',
          actor: 'system',
        });
      }
      options.onEmitRendererEvent?.({ type: 'tasks_changed', taskId: ev.taskId });
    },
    onRunStoppedAck: (taskId) => {
      taskService.markTakeoverSettled(taskId);
      options.onEmitRendererEvent?.({ type: 'tasks_changed', taskId });
    },
    onWorkerCrashed: (affectedTasks, reason) => {
      const now = new Date().toISOString() as IsoTimestamp;
      for (const taskId of affectedTasks) {
        const task = storage.tasks.getById(taskId);
        if (!task || task.executionState === 'closed') continue;
        storage.events.append({
          id: crypto.randomUUID() as EventId,
          taskId,
          type: 'system_notice',
          payload: {
            kind: 'worker_crash',
            reason,
            message:
              'Agent Worker 异常退出，已立即收回浏览器控制权。请核对网页后手动继续，系统不会自动重放操作。',
          },
          createdAt: now,
        });
        taskService.transitionState({
          taskId,
          next: { executionState: 'error', waitingReason: 'manual_control' },
          reason: 'worker_crash',
          actor: 'system',
        });
        options.onEmitRendererEvent?.({ type: 'tasks_changed', taskId });
      }
    },
  });

  const scheduler = new LocalTaskScheduler(
    leases,
    {
      isReadyToRun: () => worker.isReady,
      onDispatch: async (taskId: TaskId, epoch: Epoch) => {
        const runId = crypto.randomUUID() as RunId;
        taskService.transitionState({
          taskId,
          next: { executionState: 'running', waitingReason: 'none' },
          reason: `run_dispatched:${runId}`,
          actor: 'system',
        });
        options.onEmitRendererEvent?.({ type: 'tasks_changed', taskId });
        worker.startRun(taskId, runId, epoch);
      },
      onCancel: (taskId) => {
        cdpBridge.revokeTask(taskId);
      },
    },
    options.maxConcurrent ?? savedMaxConcurrent ?? 3,
  );

  taskService = new LocalTaskService({
    uow: storage.uow,
    tasks: storage.tasks,
    positions: storage.positions,
    events: storage.events,
    hitl: storage.hitl,
    profiles,
    confirmations,
    leases,
    scheduler,
    workbenchOrigin: options.workbenchOrigin,
    onRevokeAndStopWorker: (taskId, reason) => {
      agentEngine.questionWaiter.cancelTask(taskId);
      void agentEngine.runtime.stopTask(taskId, reason);
      worker.stopTask(taskId, reason);
    },
    onDeliverQuestionAnswer: (taskId, questionCardId, answers) => {
      const card = storage.hitl.getQuestionCard(questionCardId);
      if (card && agentEngine.questionWaiter.deliverAnswer(taskId, card.callId, answers)) {
        return true;
      }
      return worker.deliverQuestionReply(taskId, questionCardId, answers);
    },
    onTrySpliceMessage: (taskId, input) => {
      if (agentEngine.runtime.trySpliceUserMessage(taskId, input.clientMessageId, input.text)) {
        return true;
      }
      return worker.trySpliceMessage(taskId, input.clientMessageId, input.text);
    },
  });

  agentEngine = assembleDesktopAgentEngine({
    storage,
    taskService,
    profiles,
    materials,
    confirmations,
    tabs,
    browserController,
    submitGuard,
    modelRouter,
    skills,
    artifactsRootDir: options.artifactsRootDir ?? options.materialsRootDir,
    sink: {
      onStreamDelta: (delta) =>
        options.onEmitRendererEvent?.({ type: 'stream_delta', taskId: delta.taskId, delta }),
      onAssistantMessage: (ev) =>
        options.onEmitRendererEvent?.({ type: 'tasks_changed', taskId: ev.taskId }),
      onToolResult: (ev) =>
        options.onEmitRendererEvent?.({ type: 'tasks_changed', taskId: ev.taskId }),
    },
  });

  const mcpServer = new LocalTaskMcpServer(agentEngine.registry);

  const ipcRouter = new DesktopIpcRouter({
    storage,
    taskService,
    scheduler,
    profiles,
    materials,
    confirmations,
    tabs,
    modelRouter,
    credentials: options.credentials,
    skills,
    workbenchOrigin: options.workbenchOrigin,
    onDetachWindow: options.onDetachWindow,
    onNotifyTasksChanged: (taskId) =>
      options.onEmitRendererEvent?.({ type: 'tasks_changed', taskId }),
  });

  return {
    storage,
    leases,
    profiles,
    materials,
    confirmations,
    submitGuard,
    tabs,
    cdpBridge,
    browserController,
    modelRouter,
    skills,
    mcpServer,
    agentEngine,
    scheduler,
    taskService,
    worker,
    ipcRouter,
    start() {
      const recoveredTaskIds = taskService.recoverOnStartup();
      worker.start();
      if (options.enableLocalMcpServer) {
        void mcpServer.start().catch(() => {});
      }
      return { recoveredTaskIds };
    },
    async shutdown() {
      worker.shutdown();
      leases.stop();
      await mcpServer.close();
      await cdpBridge.close();
      storage.close();
    },
  };
}

/**
 * Helper to execute a single task turn directly via the assembled LocalAgentRuntime
 * (used by in-process worker transport in Electron desktop mode).
 */
export async function runTaskTurnInKernel(
  kernel: DesktopMainKernel,
  taskId: TaskId,
  runId: RunId,
  epoch: Epoch,
): Promise<{ endReason: string; error?: string }> {
  const task = kernel.storage.tasks.getById(taskId);
  if (!task) return { endReason: 'model_error', error: '任务不存在' };
  const provider = kernel.storage.providers.getDefault();
  if (!provider) {
    return { endReason: 'model_error', error: '请先在设置页配置并测试默认 BYOK 模型服务商' };
  }

  kernel.storage.runs.create({
    id: runId,
    taskId,
    epoch,
    providerSnapshot: {
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      modelId: provider.modelId,
      capabilities: provider.capabilities,
    },
    skillCatalogVersion: kernel.skills.getCatalogVersion(),
    startedAt: new Date().toISOString() as IsoTimestamp,
  });

  const outcome = await kernel.agentEngine.runtime.startRun({
    taskId,
    runId,
    epoch,
    sessionId: `${task.kind}-${task.id}` as SessionId,
    role: task.kind,
    provider,
    profileVersionId: task.profileVersionId,
    authorizedMaterialIds: kernel.storage.tasks.listAuthorizedMaterialIds(taskId),
    skillCatalogVersion: kernel.skills.getCatalogVersion(),
  });

  kernel.storage.runs.finish(runId, {
    endReason: outcome.endReason,
    finishedAt: new Date().toISOString(),
    usage: outcome.usage,
    errorCode: outcome.error?.code,
    errorMessage: outcome.error?.message,
  });

  return { endReason: outcome.endReason, error: outcome.error?.message };
}

export * from './ipc-router.js';
export * from './worker-supervisor.js';
export * from './runtime-assembly.js';
