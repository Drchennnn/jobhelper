import crypto from 'node:crypto';
import type {
  ConfirmationCardRecord,
  ConfirmationId,
  ContentHash,
  EventId,
  IsoTimestamp,
  ResolveConfirmationInput,
  RunId,
  TaskId,
} from '@jobhelper/contracts';
import type {
  EventRepository,
  HumanInTheLoopRepository,
  StorageUnitOfWork,
} from '@jobhelper/storage';
import type { ConfirmationService } from './services.js';

export class LocalConfirmationService implements ConfirmationService {
  constructor(
    private readonly uow: StorageUnitOfWork,
    private readonly hitl: HumanInTheLoopRepository,
    private readonly events: EventRepository,
  ) {}

  createConfirmation(
    card: Omit<ConfirmationCardRecord, 'id' | 'status' | 'createdAt'>,
  ): ConfirmationCardRecord {
    return this.uow.runInTransaction(() => {
      const now = new Date().toISOString() as IsoTimestamp;
      // Only one active confirmation card may exist per task at a time.
      this.hitl.invalidateConfirmations(card.taskId, 'replaced_by_new_confirmation', now);

      const created: ConfirmationCardRecord = {
        ...card,
        id: crypto.randomUUID() as ConfirmationId,
        status: 'pending',
        createdAt: now,
      };
      this.hitl.saveConfirmation(created);
      this.events.append({
        id: crypto.randomUUID() as EventId,
        taskId: card.taskId,
        runId: card.runId,
        type: 'confirmation_updated',
        payload: {
          confirmationId: created.id,
          operation: created.operation,
          status: created.status,
          contentHash: created.contentHash,
        },
        createdAt: now,
      });
      return created;
    });
  }

  resolve(input: ResolveConfirmationInput): ConfirmationCardRecord {
    return this.uow.runInTransaction(() => {
      const existing = this.hitl.getConfirmation(input.confirmationId);
      if (!existing || existing.taskId !== input.taskId) {
        throw new Error(`确认卡不存在或不属于当前任务: ${input.confirmationId}`);
      }
      if (existing.status !== 'pending') {
        throw new Error(`确认卡当前状态为 ${existing.status}，无法重复响应`);
      }

      const now = new Date().toISOString() as IsoTimestamp;
      const nextStatus =
        input.decision === 'approve'
          ? 'approved'
          : input.decision === 'manual_submitted'
            ? 'consumed'
            : 'declined';

      this.hitl.updateConfirmationStatus(existing.id, nextStatus, now);
      this.events.append({
        id: crypto.randomUUID() as EventId,
        taskId: existing.taskId,
        runId: existing.runId,
        type: 'confirmation_updated',
        payload: {
          confirmationId: existing.id,
          operation: existing.operation,
          status: nextStatus,
          decision: input.decision,
        },
        createdAt: now,
      });

      return {
        ...existing,
        status: nextStatus,
        resolvedAt: now,
      };
    });
  }

  invalidateForTask(taskId: TaskId, reason: string): number {
    return this.uow.runInTransaction(() => {
      const now = new Date().toISOString() as IsoTimestamp;
      const count = this.hitl.invalidateConfirmations(taskId, reason, now);
      if (count > 0) {
        this.events.append({
          id: crypto.randomUUID() as EventId,
          taskId,
          type: 'confirmation_updated',
          payload: {
            status: 'invalidated',
            invalidatedCount: count,
            reason,
          },
          createdAt: now,
        });
      }
      return count;
    });
  }

  assertValidAndConsume(
    taskId: TaskId,
    confirmationId: ConfirmationId,
    expectedContentHash: ContentHash,
    runId: RunId,
  ): void {
    this.uow.runInTransaction(() => {
      const card = this.hitl.getConfirmation(confirmationId);
      if (!card || card.taskId !== taskId) {
        throw new Error('缺少当前任务的有效提交确认卡');
      }
      if (card.status !== 'approved') {
        throw new Error(`提交授权无效（当前状态: ${card.status}），请重新核对确认`);
      }
      if (card.contentHash !== expectedContentHash) {
        this.hitl.updateConfirmationStatus(card.id, 'invalidated', new Date().toISOString());
        throw new Error('表单内容或附件已发生变化，原确认授权已失效，请重新核对');
      }

      const now = new Date().toISOString() as IsoTimestamp;
      this.hitl.updateConfirmationStatus(card.id, 'consumed', now);
      this.events.append({
        id: crypto.randomUUID() as EventId,
        taskId,
        runId,
        type: 'confirmation_updated',
        payload: {
          confirmationId: card.id,
          operation: card.operation,
          status: 'consumed',
        },
        createdAt: now,
      });
    });
  }
}
