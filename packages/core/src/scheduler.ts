import type { Epoch, TaskId } from '@jobhelper/contracts';
import type { TaskControlLeaseManager } from './control-lease.js';
import type { TaskScheduler } from './services.js';

export interface SchedulerHooks {
  /** Called once a task passes concurrency gating and receives a fresh epoch lease. */
  onDispatch: (taskId: TaskId, epoch: Epoch) => Promise<void>;
  /** Optional readiness predicate (e.g., worker ready & page ready). Defaults to true. */
  isReadyToRun?: (taskId: TaskId) => boolean;
  /** Optional callback when a queued or active task is cancelled. */
  onCancel?: (taskId: TaskId) => Promise<void> | void;
}

export class LocalTaskScheduler implements TaskScheduler {
  private maxConcurrent: number;
  private readonly queue: TaskId[] = [];
  private draining = false;

  constructor(
    private readonly leases: TaskControlLeaseManager,
    private readonly hooks: SchedulerHooks,
    initialMaxConcurrent = 3,
  ) {
    this.maxConcurrent = this.clampConcurrency(initialMaxConcurrent);
  }

  private clampConcurrency(limit: number): number {
    if (!Number.isFinite(limit)) return 3;
    return Math.max(1, Math.min(5, Math.floor(limit)));
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setMaxConcurrent(limit: number): void {
    this.maxConcurrent = this.clampConcurrency(limit);
  }

  getQueuedTaskIds(): TaskId[] {
    return [...this.queue];
  }

  enqueue(taskId: TaskId): void {
    if (this.leases.has(taskId)) return;
    if (this.queue.includes(taskId)) return;
    this.queue.push(taskId);
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let index = 0;
      while (index < this.queue.length && this.leases.activeTaskIds().length < this.maxConcurrent) {
        const taskId = this.queue[index]!;
        if (this.leases.has(taskId)) {
          this.queue.splice(index, 1);
          continue;
        }
        if (this.hooks.isReadyToRun && !this.hooks.isReadyToRun(taskId)) {
          index++;
          continue;
        }

        this.queue.splice(index, 1);
        const epoch = this.leases.acquire(taskId);
        try {
          await this.hooks.onDispatch(taskId, epoch);
        } catch (error) {
          // Only release if still holding the same epoch
          if (this.leases.getEpoch(taskId) === epoch) {
            this.leases.stop(taskId);
          }
          throw error;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async cancel(taskId: TaskId): Promise<void> {
    const idx = this.queue.indexOf(taskId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
    this.leases.stop(taskId);
    await this.hooks.onCancel?.(taskId);
  }
}
