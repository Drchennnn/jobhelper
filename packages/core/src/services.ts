import type {
  AnswerQuestionInput,
  ConfirmationCardRecord,
  ConfirmationId,
  ContentHash,
  ProfileId,
  ProfileVersionSnapshot,
  ResolveConfirmationInput,
  RunId,
  SendMessageInput,
  StartApplicationInput,
  StateTransitionRequest,
  TaskId,
  TaskRecord,
} from '@jobhelper/contracts';

/**
 * Unified local TaskService contract (handles both coordinator dispatch & direct URL entry).
 * Implemented in M2.
 */
export interface TaskService {
  startApplication(input: StartApplicationInput): Promise<{ task: TaskRecord; reused: boolean }>;
  enqueueUserMessage(input: SendMessageInput): Promise<{ accepted: boolean; duplicated: boolean }>;
  transitionState(request: StateTransitionRequest): TaskRecord;
  requestTakeover(taskId: TaskId): Promise<void>;
  markTakeoverSettled(taskId: TaskId): void;
  resumeAfterCheck(taskId: TaskId): Promise<void>;
  answerQuestion(input: AnswerQuestionInput): Promise<void>;
  closeTask(taskId: TaskId, reason?: string): Promise<void>;
  recoverOnStartup(): TaskId[];
}

export interface TaskScheduler {
  getMaxConcurrent(): number;
  setMaxConcurrent(limit: number): void;
  enqueue(taskId: TaskId): void;
  drain(): Promise<void>;
  cancel(taskId: TaskId): Promise<void>;
}

export interface ConfirmationService {
  createConfirmation(
    card: Omit<ConfirmationCardRecord, 'id' | 'status' | 'createdAt'>,
  ): ConfirmationCardRecord;
  resolve(input: ResolveConfirmationInput): ConfirmationCardRecord;
  invalidateForTask(taskId: TaskId, reason: string): number;
  assertValidAndConsume(
    taskId: TaskId,
    confirmationId: ConfirmationId,
    expectedContentHash: ContentHash,
    runId: RunId,
  ): void;
}

export interface ProfileBindingService {
  getDefaultProfileId(): ProfileId | null;
  setDefaultProfileId(profileId: ProfileId): void;
  createImmutableSnapshot(profileId: ProfileId): ProfileVersionSnapshot;
}
