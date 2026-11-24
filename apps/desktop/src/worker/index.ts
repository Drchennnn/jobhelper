import crypto from 'node:crypto';
import type {
  Epoch,
  MainToWorkerMessage,
  RunId,
  TaskId,
  WorkerToMainMessage,
} from '@jobhelper/contracts';

export interface WorkerProcessHost {
  handleMainMessage(message: MainToWorkerMessage): Promise<void>;
  emitToMain(message: WorkerToMainMessage): void;
}

interface PendingRpc {
  taskId: TaskId;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SharedAgentWorkerOptions {
  emit: (message: WorkerToMainMessage) => void;
  rpcTimeoutMs?: number;
  onRunStart?: (ctx: {
    taskId: TaskId;
    runId: RunId;
    epoch: Epoch;
    signal: AbortSignal;
    callMainRpc: (method: string, params?: unknown) => Promise<unknown>;
  }) => Promise<{ endReason: string; error?: string }>;
}

/**
 * Shared Agent Worker IPC host managing per-task AbortControllers,
 * request/reply RPC timeouts, and clean stop-ack teardown.
 */
export class SharedAgentWorkerHost implements WorkerProcessHost {
  private readonly activeControllers = new Map<TaskId, { epoch: Epoch; controller: AbortController }>();
  private readonly pendingRpcs = new Map<string, PendingRpc>();
  private readonly rpcTimeoutMs: number;

  constructor(private readonly options: SharedAgentWorkerOptions) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
  }

  signalReady(): void {
    this.emitToMain({ type: 'worker_ready' });
  }

  emitToMain(message: WorkerToMainMessage): void {
    this.options.emit(message);
  }

  callMainRpc(taskId: TaskId, epoch: Epoch, method: string, params: unknown = {}): Promise<unknown> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(requestId);
        reject(new Error(`Worker RPC timed out (${method})`));
      }, this.rpcTimeoutMs);

      this.pendingRpcs.set(requestId, { taskId, resolve, reject, timer });
      this.emitToMain({ type: 'rpc_request', requestId, taskId, epoch, method, params });
    });
  }

  async handleMainMessage(message: MainToWorkerMessage): Promise<void> {
    switch (message.type) {
      case 'rpc_reply': {
        const pending = this.pendingRpcs.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRpcs.delete(message.requestId);
        if (message.ok) {
          pending.resolve(message.data);
        } else {
          pending.reject(new Error(message.error ?? 'Worker RPC failed'));
        }
        return;
      }

      case 'run_stop': {
        const active = this.activeControllers.get(message.taskId);
        if (active) {
          active.controller.abort(new Error(message.reason));
          this.activeControllers.delete(message.taskId);
        }
        // Reject all in-flight RPCs for this stopped task immediately
        for (const [reqId, pending] of this.pendingRpcs.entries()) {
          if (pending.taskId === message.taskId) {
            clearTimeout(pending.timer);
            this.pendingRpcs.delete(reqId);
            pending.reject(new Error('Task stopped by user'));
          }
        }
        this.emitToMain({ type: 'run_stopped_ack', taskId: message.taskId });
        return;
      }

      case 'run_start': {
        const controller = new AbortController();
        this.activeControllers.set(message.taskId, { epoch: message.epoch, controller });
        if (!this.options.onRunStart) return;

        void this.options
          .onRunStart({
            taskId: message.taskId,
            runId: message.runId,
            epoch: message.epoch,
            signal: controller.signal,
            callMainRpc: (method, params) =>
              this.callMainRpc(message.taskId, message.epoch, method, params),
          })
          .then((outcome) => {
            const current = this.activeControllers.get(message.taskId);
            if (current?.epoch === message.epoch) {
              this.activeControllers.delete(message.taskId);
              this.emitToMain({
                type: 'run_finished',
                taskId: message.taskId,
                runId: message.runId,
                epoch: message.epoch,
                endReason: outcome.endReason,
                error: outcome.error,
              });
            }
          })
          .catch((error) => {
            const current = this.activeControllers.get(message.taskId);
            if (current?.epoch === message.epoch) {
              this.activeControllers.delete(message.taskId);
              this.emitToMain({
                type: 'run_finished',
                taskId: message.taskId,
                runId: message.runId,
                epoch: message.epoch,
                endReason: 'model_error',
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
        return;
      }

      case 'question_reply':
      case 'message_splice':
        // Wired into @jobhelper/runtime QuestionWaitCoordinator & loop in M3
        return;
    }
  }
}
