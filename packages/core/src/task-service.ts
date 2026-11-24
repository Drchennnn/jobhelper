import crypto from 'node:crypto';
import type {
  AnswerQuestionInput,
  BrowserProfileId,
  EventId,
  IsoTimestamp,
  MaterialId,
  PositionId,
  ProfileId,
  SendMessageInput,
  StartApplicationInput,
  StateTransitionRequest,
  TaskId,
  TaskRecord,
} from '@jobhelper/contracts';
import type {
  EventRepository,
  HumanInTheLoopRepository,
  PositionRepository,
  StorageUnitOfWork,
  TaskRepository,
} from '@jobhelper/storage';
import type { LocalConfirmationService } from './confirmation-service.js';
import type { TaskControlLeaseManager } from './control-lease.js';
import type { LocalProfileService } from './profile-service.js';
import type { TaskScheduler, TaskService } from './services.js';
import { assertValidFourAxisTransition } from './state-machine.js';
import { normalizeApplyUrl, validateBrowserUrl } from './url-policy.js';

export const RESUME_CHECK_PROMPT = '已完成，请检查当前页面后继续。';

export interface TaskServiceDependencies {
  uow: StorageUnitOfWork;
  tasks: TaskRepository;
  positions: PositionRepository;
  events: EventRepository;
  hitl: HumanInTheLoopRepository;
  profiles: LocalProfileService;
  confirmations: LocalConfirmationService;
  leases: TaskControlLeaseManager;
  scheduler?: TaskScheduler;
  workbenchOrigin?: string;
  /** Immediately revokes scoped CDP bridge & stops worker for taskId. */
  onRevokeAndStopWorker?: (taskId: TaskId, reason: string) => Promise<void> | void;
  /** Optional live delivery hook for an active ask_user_question waiter. */
  onDeliverQuestionAnswer?: (
    taskId: TaskId,
    questionCardId: string,
    answers: AnswerQuestionInput['answers'],
  ) => Promise<boolean> | boolean;
  /** Optional hook to try splicing a running user message without attachments. */
  onTrySpliceMessage?: (taskId: TaskId, input: SendMessageInput) => boolean;
}

export class LocalTaskService implements TaskService {
  private readonly inflightStarts = new Map<
    string,
    Promise<{ task: TaskRecord; reused: boolean }>
  >();

  constructor(private readonly deps: TaskServiceDependencies) {}

  createCoordinatorConversation(title = '求职总助手'): TaskRecord {
    return this.deps.uow.runInTransaction(() => {
      const now = new Date().toISOString() as IsoTimestamp;
      const task: TaskRecord = {
        id: crypto.randomUUID() as TaskId,
        kind: 'coordinator',
        title,
        browserProfileId: 'default' as BrowserProfileId,
        controlMode: 'human',
        executionState: 'draft',
        waitingReason: 'none',
        applicationStage: 'created',
        outcome: 'not_submitted',
        createdAt: now,
        updatedAt: now,
      };
      this.deps.tasks.insert(task);
      return task;
    });
  }

  async startApplication(
    input: StartApplicationInput,
  ): Promise<{ task: TaskRecord; reused: boolean }> {
    const validUrl = validateBrowserUrl(input.applyUrl, this.deps.workbenchOrigin);
    const normalizedUrl = normalizeApplyUrl(validUrl, this.deps.workbenchOrigin);

    const inflight = this.inflightStarts.get(normalizedUrl);
    if (inflight) {
      return inflight;
    }

    const work = Promise.resolve().then(() => {
      const result = this.deps.uow.runInTransaction(() => {
        // INV-05: Reuse existing active application for the same normalized URL
        const existing = this.deps.tasks.findActiveApplicationByUrl(normalizedUrl);
        if (existing) {
          return { task: existing, reused: true };
        }

        const profileId = input.profileId ?? this.deps.profiles.getDefaultProfileId();
        if (!profileId) {
          throw new Error('请先创建或选择一份个人档案，再开始网申任务');
        }
        const snapshot = this.deps.profiles.createImmutableSnapshot(profileId);
        const profileData = this.deps.profiles.getProfileWithActiveVersion(profileId);

        const now = new Date().toISOString() as IsoTimestamp;
        let positionId = input.positionId;
        let company = '';
        let jobTitle = '';

        if (positionId) {
          const pos = this.deps.positions.getById(positionId);
          if (!pos) {
            throw new Error(`岗位记录不存在: ${positionId}`);
          }
          company = pos.company;
          jobTitle = pos.jobTitle;
        } else {
          const existingPos = this.deps.positions.findByNormalizedUrl(normalizedUrl);
          if (existingPos) {
            positionId = existingPos.id;
            company = existingPos.company;
            jobTitle = existingPos.jobTitle;
          } else {
            const host = new URL(validUrl).hostname;
            positionId = crypto.randomUUID() as PositionId;
            company = host;
            jobTitle = '待识别岗位';
            this.deps.positions.upsert({
              id: positionId,
              company,
              jobTitle,
              applyUrl: validUrl,
              normalizedApplyUrl: normalizedUrl,
              progressStage: 'in_progress',
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        const authorizedMaterialIds: MaterialId[] = input.materialIds
          ? [...new Set(input.materialIds)]
          : profileData?.profile.defaultResumeMaterialId
            ? [profileData.profile.defaultResumeMaterialId]
            : [];

        const task: TaskRecord = {
          id: crypto.randomUUID() as TaskId,
          kind: 'application',
          title: jobTitle === '待识别岗位' ? company : `${company} - ${jobTitle}`,
          company,
          jobTitle,
          applyUrl: validUrl,
          normalizedApplyUrl: normalizedUrl,
          positionId,
          originConversationId: input.originConversationId,
          profileVersionId: snapshot.id,
          browserProfileId: 'default' as BrowserProfileId,
          controlMode: 'human',
          executionState: 'queued',
          waitingReason: 'none',
          applicationStage: 'created',
          outcome: 'not_submitted',
          createdAt: now,
          updatedAt: now,
        };

        this.deps.tasks.insert(task, authorizedMaterialIds);
        this.deps.events.append({
          id: crypto.randomUUID() as EventId,
          taskId: task.id,
          type: 'system_notice',
          payload: {
            kind: 'task_created',
            applyUrl: validUrl,
            profileVersionId: snapshot.id,
            authorizedMaterialIds,
            note: input.note,
          },
          createdAt: now,
        });

        return { task, reused: false };
      });

      if (!result.reused) {
        this.deps.scheduler?.enqueue(result.task.id);
      }
      return result;
    });

    this.inflightStarts.set(normalizedUrl, work);
    try {
      return await work;
    } finally {
      this.inflightStarts.delete(normalizedUrl);
    }
  }

  async enqueueUserMessage(
    input: SendMessageInput,
  ): Promise<{ accepted: boolean; duplicated: boolean }> {
    const task = this.deps.tasks.getById(input.taskId);
    if (!task) {
      throw new Error(`任务不存在: ${input.taskId}`);
    }
    if (task.executionState === 'closed') {
      throw new Error('任务已关闭，无法发送新消息');
    }

    if (this.deps.events.hasClientMessage(input.taskId, input.clientMessageId)) {
      return { accepted: false, duplicated: true };
    }

    const now = new Date().toISOString() as IsoTimestamp;
    this.deps.uow.runInTransaction(() => {
      this.deps.events.append({
        id: crypto.randomUUID() as EventId,
        taskId: input.taskId,
        type: 'user_message',
        clientMessageId: input.clientMessageId,
        payload: {
          text: input.text,
          materialIds: input.materialIds ?? [],
        },
        createdAt: now,
      });

      if (input.materialIds && input.materialIds.length > 0) {
        const current = this.deps.tasks.listAuthorizedMaterialIds(input.taskId);
        const merged = [...new Set([...current, ...input.materialIds])];
        this.deps.tasks.setAuthorizedMaterials(input.taskId, merged, now);
        // Adding/changing attachments invalidates pending submission confirmations (INV-07)
        this.deps.confirmations.invalidateForTask(input.taskId, 'attachments_changed');
      }
    });

    const hasAttachments = Boolean(input.materialIds && input.materialIds.length > 0);
    if (task.executionState === 'running' && !hasAttachments && this.deps.onTrySpliceMessage) {
      const spliced = this.deps.onTrySpliceMessage(input.taskId, input);
      if (spliced) {
        return { accepted: true, duplicated: false };
      }
    }

    if (task.executionState !== 'running' && task.executionState !== 'stopping') {
      this.transitionState({
        taskId: input.taskId,
        next: { executionState: 'queued', waitingReason: 'none' },
        reason: 'user_message_enqueued',
        actor: 'user',
      });
      this.deps.scheduler?.enqueue(input.taskId);
    }

    return { accepted: true, duplicated: false };
  }

  transitionState(request: StateTransitionRequest): TaskRecord {
    return this.deps.uow.runInTransaction(() => {
      const task = this.deps.tasks.getById(request.taskId);
      if (!task) {
        throw new Error(`任务不存在: ${request.taskId}`);
      }

      const nextAxes = assertValidFourAxisTransition(task, request.next);
      const now = new Date().toISOString() as IsoTimestamp;

      const nextControlMode =
        nextAxes.executionState === 'running'
          ? 'agent'
          : nextAxes.executionState === 'stopping'
            ? 'stopping'
            : 'human';

      const updated: TaskRecord = {
        ...task,
        ...nextAxes,
        controlMode: nextControlMode,
        updatedAt: now,
        closedAt: nextAxes.executionState === 'closed' ? (task.closedAt ?? now) : task.closedAt,
      };
      this.deps.tasks.update(updated);
      this.deps.events.append({
        id: crypto.randomUUID() as EventId,
        taskId: task.id,
        type: 'status_transition',
        payload: {
          from: {
            executionState: task.executionState,
            waitingReason: task.waitingReason,
            applicationStage: task.applicationStage,
            outcome: task.outcome,
          },
          to: nextAxes,
          reason: request.reason,
          actor: request.actor,
        },
        createdAt: now,
      });

      return updated;
    });
  }

  /**
   * INV-02: Revokes lease & CDP BEFORE handing control to human to prevent late clicks.
   */
  async requestTakeover(taskId: TaskId): Promise<void> {
    const task = this.deps.tasks.getById(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    if (task.executionState === 'closed') return;

    // 1. Revoke lease first so any in-flight browser mutation is immediately rejected
    this.deps.leases.stop(taskId);
    await this.deps.scheduler?.cancel(taskId);

    // 2. Mark stopping (or directly paused if not running)
    if (task.executionState === 'running' || task.executionState === 'queued') {
      this.transitionState({
        taskId,
        next: { executionState: 'stopping', waitingReason: 'manual_control' },
        reason: 'user_requested_takeover',
        actor: 'user',
      });
    } else if (task.executionState !== 'paused') {
      this.transitionState({
        taskId,
        next: { executionState: 'paused', waitingReason: 'manual_control' },
        reason: 'user_requested_takeover',
        actor: 'user',
      });
    }

    // 3. Revoke CDP & stop worker
    await this.deps.onRevokeAndStopWorker?.(taskId, 'user_takeover');

    // If no async worker stop handshake is pending, settle immediately to paused
    if (!this.deps.onRevokeAndStopWorker) {
      this.markTakeoverSettled(taskId);
    }
  }

  markTakeoverSettled(taskId: TaskId): void {
    const task = this.deps.tasks.getById(taskId);
    if (!task || task.executionState !== 'stopping') return;
    this.transitionState({
      taskId,
      next: { executionState: 'paused', waitingReason: 'manual_control' },
      reason: 'worker_stopped_ack',
      actor: 'system',
    });
  }

  /**
   * Resumes by creating a new queued run that must re-observe the page first.
   * Never assumes login/captcha/submission succeeded just because the user clicked continue.
   */
  async resumeAfterCheck(taskId: TaskId): Promise<void> {
    const task = this.deps.tasks.getById(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    if (!['paused', 'waiting_user', 'interrupted', 'error', 'draft'].includes(task.executionState)) {
      throw new Error(`当前状态 (${task.executionState}) 无法直接继续检查`);
    }

    const now = new Date().toISOString() as IsoTimestamp;
    this.deps.uow.runInTransaction(() => {
      // User may have modified fields while holding control -> invalidate any prior review confirmation (INV-07)
      if (task.waitingReason === 'manual_control' || task.executionState === 'paused') {
        this.deps.confirmations.invalidateForTask(taskId, 'user_manual_takeover_resume');
      }

      this.deps.events.append({
        id: crypto.randomUUID() as EventId,
        taskId,
        type: 'user_message',
        payload: {
          text: RESUME_CHECK_PROMPT,
          isResumeCheck: true,
        },
        createdAt: now,
      });

      this.transitionState({
        taskId,
        next: {
          executionState: 'queued',
          waitingReason: 'none',
        },
        reason: 'user_requested_resume_check',
        actor: 'user',
      });
    });

    this.deps.scheduler?.enqueue(taskId);
  }

  async answerQuestion(input: AnswerQuestionInput): Promise<void> {
    const card = this.deps.hitl.getQuestionCard(input.questionCardId);
    if (!card || card.taskId !== input.taskId) {
      throw new Error(`问题卡不存在或不属于当前任务: ${input.questionCardId}`);
    }
    if (card.status === 'answered' || card.status === 'cancelled') {
      throw new Error(`问题卡当前状态为 ${card.status}，无法重复提交回答`);
    }

    const questionMap = new Map(card.questions.map((q) => [q.id, q]));
    const answersRecord: Record<string, { value: string; saveToProfile: boolean }> = {};
    for (const ans of input.answers) {
      const q = questionMap.get(ans.questionId);
      if (!q) {
        throw new Error(`未知的问题 ID: ${ans.questionId}`);
      }
      answersRecord[ans.questionId] = {
        value: ans.value,
        saveToProfile: ans.saveToProfile,
      };
    }

    const now = new Date().toISOString() as IsoTimestamp;
    const task = this.deps.tasks.getById(input.taskId);
    const taskProfileId: ProfileId | undefined = task?.profileVersionId
      ? this.deps.profiles.getSnapshot(task.profileVersionId)?.profileId
      : undefined;

    this.deps.uow.runInTransaction(() => {
      this.deps.hitl.recordQuestionAnswers(card.id, answersRecord, now);
      this.deps.events.append({
        id: crypto.randomUUID() as EventId,
        taskId: input.taskId,
        runId: card.runId,
        type: 'question_answered',
        payload: {
          questionCardId: card.id,
          callId: card.callId,
          answers: input.answers,
        },
        createdAt: now,
      });

      for (const ans of input.answers) {
        if (ans.saveToProfile) {
          const q = questionMap.get(ans.questionId)!;
          this.deps.profiles.rememberFact({
            scope: taskProfileId ? 'profile' : 'global',
            profileId: taskProfileId,
            key: q.prompt,
            value: ans.value,
            source: 'question_reply',
          });
        }
      }
    });

    const deliveredLive =
      (await this.deps.onDeliverQuestionAnswer?.(input.taskId, card.id, input.answers)) ?? false;

    // Late answer after timeout/turn end: preserve answer bound to original questionId and queue next run
    if (!deliveredLive && task && task.executionState !== 'running' && task.executionState !== 'closed') {
      this.transitionState({
        taskId: input.taskId,
        next: { executionState: 'queued', waitingReason: 'none' },
        reason: 'late_question_answer_queued',
        actor: 'user',
      });
      this.deps.scheduler?.enqueue(input.taskId);
    }
  }

  async closeTask(taskId: TaskId, reason = 'user_closed'): Promise<void> {
    const task = this.deps.tasks.getById(taskId);
    if (!task || task.executionState === 'closed') return;

    this.deps.leases.stop(taskId);
    await this.deps.scheduler?.cancel(taskId);
    await this.deps.onRevokeAndStopWorker?.(taskId, 'task_closed');

    const nextOutcome =
      task.outcome === 'not_submitted' ? 'closed_without_submit' : task.outcome;

    this.transitionState({
      taskId,
      next: {
        executionState: 'closed',
        waitingReason: 'none',
        outcome: nextOutcome,
      },
      reason,
      actor: 'user',
    });
  }

  recoverOnStartup(): TaskId[] {
    const now = new Date().toISOString() as IsoTimestamp;
    return this.deps.uow.runInTransaction(() => {
      const recovered = this.deps.tasks.recoverInterruptedTasksOnStartup(now);
      for (const taskId of recovered) {
        this.deps.events.append({
          id: crypto.randomUUID() as EventId,
          taskId,
          type: 'system_notice',
          payload: {
            kind: 'startup_interrupted_recovery',
            message: '上次执行因应用退出而中断，请先核对右侧网页当前状态后再手动继续。系统不会自动重放旧操作。',
          },
          createdAt: now,
        });
      }
      return recovered;
    });
  }
}
