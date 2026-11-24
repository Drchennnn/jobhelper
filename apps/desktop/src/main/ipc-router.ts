import type {
  AnswerQuestionInput,
  BrowserSurfaceLayoutInput,
  ProviderId,
  RendererToMainIpc,
  ResolveConfirmationInput,
  SendMessageInput,
  StartApplicationInput,
  TabId,
  TaskEventRecord,
  TaskId,
  TaskRecord,
} from '@jobhelper/contracts';
import type { LocalTaskTabManager } from '@jobhelper/browser-bridge';
import type { LocalConfirmationService, LocalTaskService } from '@jobhelper/core';
import type { ModelRouter } from '@jobhelper/model-router';
import type { EventRepository, TaskRepository } from '@jobhelper/storage';

export interface DesktopIpcDependencies {
  tasksRepo: TaskRepository;
  eventsRepo: EventRepository;
  taskService: LocalTaskService;
  confirmations: LocalConfirmationService;
  tabs: LocalTaskTabManager;
  modelRouter: ModelRouter;
  onDetachWindow?: (taskId: TaskId) => Promise<void> | void;
}

/**
 * Strongly typed implementation of all RendererToMainIpc channels.
 * Enforces takeover-before-manual-navigation and takeover-before-window-detach invariants.
 */
export class DesktopIpcRouter implements RendererToMainIpc {
  constructor(private readonly deps: DesktopIpcDependencies) {}

  'tasks:list' = async (): Promise<TaskRecord[]> => {
    return this.deps.tasksRepo.listAll();
  };

  'tasks:startApplication' = async (
    input: StartApplicationInput,
  ): Promise<{ taskId: TaskId; reused: boolean }> => {
    const { task, reused } = await this.deps.taskService.startApplication(input);
    if (!reused && task.applyUrl) {
      const existingTabs = this.deps.tabs.listTabs(task.id);
      if (existingTabs.length === 0) {
        await this.deps.tabs.createTab(task.id, task.applyUrl, task.browserProfileId);
      }
    }
    return { taskId: task.id, reused };
  };

  'tasks:sendMessage' = async (
    input: SendMessageInput,
  ): Promise<{ accepted: boolean; duplicated: boolean }> => {
    return this.deps.taskService.enqueueUserMessage(input);
  };

  'tasks:takeover' = async (input: { taskId: TaskId }): Promise<void> => {
    await this.deps.taskService.requestTakeover(input.taskId);
  };

  'tasks:resumeCheck' = async (input: { taskId: TaskId }): Promise<void> => {
    await this.deps.taskService.resumeAfterCheck(input.taskId);
  };

  'tasks:close' = async (input: { taskId: TaskId }): Promise<void> => {
    await this.deps.taskService.closeTask(input.taskId);
    await this.deps.tabs.closeAllTabsForTask(input.taskId);
  };

  'tasks:answerQuestion' = async (input: AnswerQuestionInput): Promise<void> => {
    await this.deps.taskService.answerQuestion(input);
  };

  'tasks:resolveConfirmation' = async (input: ResolveConfirmationInput): Promise<void> => {
    const resolved = this.deps.confirmations.resolve(input);
    if (input.decision === 'manual_submitted') {
      this.deps.taskService.transitionState({
        taskId: input.taskId,
        next: {
          executionState: 'closed',
          waitingReason: 'none',
          applicationStage: 'done',
          outcome: 'user_reported',
        },
        reason: `user_confirmed_manual_submission:${resolved.id}`,
        actor: 'user',
      });
    } else if (input.decision === 'decline') {
      this.deps.taskService.transitionState({
        taskId: input.taskId,
        next: {
          executionState: 'paused',
          waitingReason: 'manual_control',
        },
        reason: `user_declined_confirmation:${resolved.id}`,
        actor: 'user',
      });
    }
  };

  'tasks:events' = async (input: { taskId: TaskId; afterSeq?: number }): Promise<TaskEventRecord[]> => {
    return this.deps.eventsRepo.listByTask(input.taskId, input.afterSeq ?? 0);
  };

  'browser:syncSurface' = async (input: BrowserSurfaceLayoutInput): Promise<void> => {
    this.deps.tabs.syncSurfaceBounds(input.taskId, input.visible, input.bounds);
  };

  'browser:navigate' = async (input: { taskId: TaskId; tabId: TabId; url: string }): Promise<void> => {
    // Always stop active agent before manual user navigation so old actions never run on new page
    await this.deps.taskService.requestTakeover(input.taskId);
    const managed = this.deps.tabs
      .getManagedTabs(input.taskId)
      .find((t) => t.id === input.tabId);
    if (!managed) {
      throw new Error(`标签页不属于当前任务: ${input.tabId}`);
    }
    await managed.view.webContents.loadURL(input.url);
  };

  'browser:detachWindow' = async (input: { taskId: TaskId }): Promise<void> => {
    // Stop agent before detaching WebContentsView to a standalone window
    await this.deps.taskService.requestTakeover(input.taskId);
    await this.deps.onDetachWindow?.(input.taskId);
  };

  'providers:probe' = async (input: { providerId: ProviderId }): Promise<{ ok: boolean; error?: string }> => {
    try {
      await this.deps.modelRouter.probe(input.providerId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export interface ElectronIpcMainLike {
  handle(channel: string, listener: (_event: unknown, arg: unknown) => Promise<unknown>): void;
}

export const RENDERER_TO_MAIN_CHANNELS: readonly (keyof RendererToMainIpc)[] = [
  'tasks:list',
  'tasks:startApplication',
  'tasks:sendMessage',
  'tasks:takeover',
  'tasks:resumeCheck',
  'tasks:close',
  'tasks:answerQuestion',
  'tasks:resolveConfirmation',
  'tasks:events',
  'browser:syncSurface',
  'browser:navigate',
  'browser:detachWindow',
  'providers:probe',
];

export function registerDesktopIpcHandlers(
  ipcMain: ElectronIpcMainLike,
  router: DesktopIpcRouter,
): void {
  for (const channel of RENDERER_TO_MAIN_CHANNELS) {
    ipcMain.handle(channel, async (_event, arg) => {
      const fn = router[channel] as (input?: unknown) => Promise<unknown>;
      return fn(arg);
    });
  }
}
