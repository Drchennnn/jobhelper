import crypto from 'node:crypto';
import type { Epoch, TaskId } from '@jobhelper/contracts';

/**
 * Per-task execution lease ensuring stopped or superseded runs cannot mutate pages or business state.
 */
export interface TaskControlLeaseManager {
  acquire(taskId: TaskId): Epoch;
  assert(taskId: TaskId, epoch: Epoch): void;
  has(taskId: TaskId): boolean;
  getEpoch(taskId: TaskId): Epoch | null;
  stop(taskId?: TaskId): void;
  activeTaskIds(): TaskId[];
}

export class ControlLease {
  private owner: TaskId | null = null;
  private currentEpoch: Epoch = crypto.randomUUID() as Epoch;

  get epoch(): Epoch {
    return this.currentEpoch;
  }

  get activeOwner(): TaskId | null {
    return this.owner;
  }

  acquire(taskId: TaskId): Epoch {
    if (this.owner) {
      throw new Error('上一轮正在处理，请先停止');
    }
    this.owner = taskId;
    this.currentEpoch = crypto.randomUUID() as Epoch;
    return this.currentEpoch;
  }

  assert(taskId: TaskId, epoch: Epoch): void {
    if (this.owner !== taskId || this.currentEpoch !== epoch) {
      throw new Error('操作已暂停或轮次已过期，请重新观察页面后继续');
    }
  }

  stop(): void {
    this.owner = null;
    this.currentEpoch = crypto.randomUUID() as Epoch;
  }
}

/**
 * Separate leases per task allow independent tasks to execute concurrently without sharing control.
 */
export class TaskControls implements TaskControlLeaseManager {
  private readonly leases = new Map<TaskId, ControlLease>();

  acquire(taskId: TaskId): Epoch {
    if (this.leases.has(taskId)) {
      throw new Error(`本任务上一轮正在处理 (${taskId})`);
    }
    const lease = new ControlLease();
    const epoch = lease.acquire(taskId);
    this.leases.set(taskId, lease);
    return epoch;
  }

  assert(taskId: TaskId, epoch: Epoch): void {
    const lease = this.leases.get(taskId);
    if (!lease) {
      throw new Error('操作已暂停或轮次已过期，请重新观察页面后继续');
    }
    lease.assert(taskId, epoch);
  }

  has(taskId: TaskId): boolean {
    return this.leases.has(taskId);
  }

  getEpoch(taskId: TaskId): Epoch | null {
    return this.leases.get(taskId)?.epoch ?? null;
  }

  stop(taskId?: TaskId): void {
    if (taskId) {
      this.leases.get(taskId)?.stop();
      this.leases.delete(taskId);
      return;
    }
    for (const lease of this.leases.values()) {
      lease.stop();
    }
    this.leases.clear();
  }

  activeTaskIds(): TaskId[] {
    return [...this.leases.keys()];
  }
}
