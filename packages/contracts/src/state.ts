import type {
  BrowserProfileId,
  IsoTimestamp,
  PositionId,
  ProfileVersionId,
  TaskId,
} from './ids.js';

export type TaskKind = 'coordinator' | 'application';

/** Axis 1: Execution lifecycle state of a task. */
export type ExecutionState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'stopping'
  | 'paused'
  | 'waiting_user'
  | 'interrupted'
  | 'error'
  | 'closed';

/** Axis 2: Structured reason why a task is awaiting human action. */
export type WaitingReason =
  | 'none'
  | 'login'
  | 'captcha'
  | 'missing_info'
  | 'manual_control'
  | 'submission_confirmation'
  | 'manual_submit'
  | 'result_check';

/** Axis 3: Progress stage on the target recruitment form. */
export type ApplicationStage =
  | 'created'
  | 'opened'
  | 'inspecting'
  | 'filling'
  | 'filling_ready'
  | 'submit_attempted'
  | 'verifying'
  | 'done';

/** Axis 4: Business submission outcome (strictly decoupled from run endReason). */
export type ApplicationOutcome =
  | 'not_submitted'
  | 'unknown'
  | 'submitted_verified'
  | 'user_reported'
  | 'job_unavailable'
  | 'closed_without_submit';

export type RunEndReason =
  | 'completed'
  | 'waiting_user'
  | 'stopped_by_user'
  | 'interrupted'
  | 'model_error'
  | 'browser_error'
  | 'worker_crash';

export type BrowserControlMode = 'agent' | 'stopping' | 'human';

export interface FourAxisState {
  executionState: ExecutionState;
  waitingReason: WaitingReason;
  applicationStage: ApplicationStage;
  outcome: ApplicationOutcome;
}

export interface TaskRecord extends FourAxisState {
  id: TaskId;
  kind: TaskKind;
  title: string;
  company?: string;
  jobTitle?: string;
  applyUrl?: string;
  normalizedApplyUrl?: string;
  positionId?: PositionId;
  originConversationId?: TaskId;
  /** Immutable profile snapshot locked at task creation for application tasks. */
  profileVersionId?: ProfileVersionId;
  browserProfileId: BrowserProfileId;
  controlMode: BrowserControlMode;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  closedAt?: IsoTimestamp;
}

export interface StateTransitionRequest {
  taskId: TaskId;
  next: Partial<FourAxisState>;
  reason: string;
  actor: 'system' | 'agent' | 'user';
}
