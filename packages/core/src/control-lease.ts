import type { Epoch, TaskId } from '@jobhelper/contracts';

/**
 * Per-task execution lease ensuring stopped or superseded runs cannot mutate pages or business state.
 * Implemented in M2.
 */
export interface TaskControlLeaseManager {
  acquire(taskId: TaskId): Epoch;
  assert(taskId: TaskId, epoch: Epoch): void;
  has(taskId: TaskId): boolean;
  stop(taskId?: TaskId): void;
  activeTaskIds(): TaskId[];
}
