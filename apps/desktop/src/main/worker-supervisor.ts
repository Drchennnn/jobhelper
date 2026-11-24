import type {
  AnswerQuestionInput,
  ClientMessageId,
  Epoch,
  MainToWorkerMessage,
  RunId,
  StreamDeltaEvent,
  TaskId,
  WorkerToMainMessage,
} from '@jobhelper/contracts';
import type { TaskControlLeaseManager } from '@jobhelper/core';

export interface WorkerChildTransport {
  send(message: MainToWorkerMessage): void;
  onMessage(handler: (message: WorkerToMainMessage) => void): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

export interface WorkerSupervisorOptions {
  leases: TaskControlLeaseManager;
  spawnWorker: () => WorkerChildTransport;
  onRevokeCdp: (taskId: TaskId) => void;
  onRpcRequest: (
    taskId: TaskId,
    epoch: Epoch,
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  onStreamDelta?: (delta: StreamDeltaEvent) => void;
  onRunFinished?: (event: {
    taskId: TaskId;
    runId: RunId;
    epoch: Epoch;
    endReason: string;
    error?: string;
  }) => void;
  onRunStoppedAck?: (taskId: TaskId) => void;
  onWorkerCrashed?: (affectedTasks: TaskId[], reason: string) => void;
  stopAckTimeoutMs?: number;
}

/**
 * Supervises the shared Agent Worker process from Electron Main Process:
 * - Validates (taskId, epoch) on every incoming worker RPC request
 * - Manages stop-ack timeouts so takeover never hangs UI
 * - On worker crash: revokes ALL active leases & CDP routes immediately without replaying actions
 */
export class WorkerProcessSupervisor {
  private child: WorkerChildTransport | null = null;
  private ready = false;
  private readonly stopAckTimers = new Map<TaskId, ReturnType<typeof setTimeout>>();
  private readonly stopAckTimeoutMs: number;

  constructor(private readonly options: WorkerSupervisorOptions) {
    this.stopAckTimeoutMs = options.stopAckTimeoutMs ?? 3000;
  }

  get isReady(): boolean {
    return this.ready && this.child !== null;
  }

  start(): void {
    if (this.child) return;
    const child = this.options.spawnWorker();
    this.child = child;
    this.ready = false;

    child.onMessage((msg) => {
      void this.handleMessage(child, msg);
    });

    child.onExit((code, signal) => {
      if (this.child !== child) return;
      this.handleCrash(`Worker exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
    });
  }

  startRun(taskId: TaskId, runId: RunId, epoch: Epoch): void {
    this.assertChild().send({ type: 'run_start', taskId, runId, epoch });
  }

  stopTask(taskId: TaskId, reason: string): void {
    // Always revoke lease & CDP immediately before signalling worker
    this.options.leases.stop(taskId);
    this.options.onRevokeCdp(taskId);

    if (!this.child) {
      this.options.onRunStoppedAck?.(taskId);
      return;
    }

    const existingTimer = this.stopAckTimers.get(taskId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.stopAckTimers.delete(taskId);
      this.options.onRunStoppedAck?.(taskId);
    }, this.stopAckTimeoutMs);
    this.stopAckTimers.set(taskId, timer);

    this.child.send({ type: 'run_stop', taskId, reason });
  }

  deliverQuestionReply(
    taskId: TaskId,
    questionCardId: string,
    answers: AnswerQuestionInput['answers'],
  ): boolean {
    if (!this.isReady || !this.child) return false;
    this.child.send({ type: 'question_reply', taskId, questionCardId, answers });
    return true;
  }

  trySpliceMessage(taskId: TaskId, clientMessageId: ClientMessageId, text: string): boolean {
    if (!this.isReady || !this.child) return false;
    this.child.send({ type: 'message_splice', taskId, clientMessageId, text });
    return true;
  }

  shutdown(): void {
    for (const timer of this.stopAckTimers.values()) clearTimeout(timer);
    this.stopAckTimers.clear();
    const child = this.child;
    this.child = null;
    this.ready = false;
    child?.kill();
  }

  private assertChild(): WorkerChildTransport {
    if (!this.child) {
      throw new Error('Agent Worker 尚未启动');
    }
    return this.child;
  }

  private async handleMessage(child: WorkerChildTransport, msg: WorkerToMainMessage): Promise<void> {
    if (this.child !== child) return;

    switch (msg.type) {
      case 'worker_ready':
        this.ready = true;
        return;

      case 'stream_delta':
        try {
          this.options.leases.assert(msg.delta.taskId, msg.delta.epoch);
          this.options.onStreamDelta?.(msg.delta);
        } catch {
          // Drop stale deltas from revoked epochs silently
        }
        return;

      case 'run_stopped_ack': {
        const timer = this.stopAckTimers.get(msg.taskId);
        if (timer) {
          clearTimeout(timer);
          this.stopAckTimers.delete(msg.taskId);
        }
        this.options.onRunStoppedAck?.(msg.taskId);
        return;
      }

      case 'run_finished': {
        // Ignore stale finish events if a newer epoch already started
        const currentEpoch = this.options.leases.getEpoch(msg.taskId);
        if (currentEpoch && currentEpoch !== msg.epoch) return;
        this.options.leases.stop(msg.taskId);
        this.options.onRevokeCdp(msg.taskId);
        this.options.onRunFinished?.(msg);
        return;
      }

      case 'rpc_request': {
        try {
          this.options.leases.assert(msg.taskId, msg.epoch);
          const data = await this.options.onRpcRequest(msg.taskId, msg.epoch, msg.method, msg.params);
          this.options.leases.assert(msg.taskId, msg.epoch);
          child.send({ type: 'rpc_reply', requestId: msg.requestId, ok: true, data });
        } catch (error) {
          child.send({
            type: 'rpc_reply',
            requestId: msg.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    }
  }

  private handleCrash(reason: string): void {
    const affectedTasks = this.options.leases.activeTaskIds();
    this.child = null;
    this.ready = false;

    for (const timer of this.stopAckTimers.values()) clearTimeout(timer);
    this.stopAckTimers.clear();

    // Revoke ALL active task leases & CDP routes immediately
    this.options.leases.stop();
    for (const taskId of affectedTasks) {
      this.options.onRevokeCdp(taskId);
    }

    this.options.onWorkerCrashed?.(affectedTasks, reason);
  }
}
