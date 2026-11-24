import type {
  ArtifactId,
  CallId,
  ClientMessageId,
  ConfirmationId,
  ContentHash,
  Epoch,
  EventId,
  IsoTimestamp,
  MaterialId,
  QuestionId,
  RunId,
  TaskId,
  TodoId,
} from './ids.js';
import type { FourAxisState, WaitingReason } from './state.js';

export type TaskEventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'status_transition'
  | 'todo_updated'
  | 'question_asked'
  | 'question_answered'
  | 'confirmation_updated'
  | 'system_notice';

export interface TaskEventRecord<TPayload = Record<string, unknown>> {
  id: EventId;
  taskId: TaskId;
  runId?: RunId;
  epoch?: Epoch;
  seq: number;
  type: TaskEventType;
  clientMessageId?: ClientMessageId;
  payload: TPayload;
  createdAt: IsoTimestamp;
}

export interface StreamDeltaEvent {
  taskId: TaskId;
  runId: RunId;
  epoch: Epoch;
  attemptId: string;
  textDelta: string;
  reasoningDelta: string;
  done: boolean;
}

export interface QuestionItem {
  id: QuestionId;
  prompt: string;
  options?: string[];
  allowFreeText: boolean;
  saveToProfileDefault: boolean;
}

export type QuestionCardStatus = 'pending' | 'answered' | 'expired_pending' | 'cancelled';

export interface QuestionCardRecord {
  id: string;
  taskId: TaskId;
  runId: RunId;
  callId: CallId;
  questions: QuestionItem[];
  status: QuestionCardStatus;
  answers?: Record<string, { value: string; saveToProfile: boolean }>;
  createdAt: IsoTimestamp;
  answeredAt?: IsoTimestamp;
}

export type ConfirmationOperation = 'final_submit' | 'save_draft' | 'irreversible_step';
export type ConfirmationStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'invalidated'
  | 'consumed'
  | 'expired';

export interface ConfirmationCardRecord {
  id: ConfirmationId;
  taskId: TaskId;
  runId: RunId;
  operation: ConfirmationOperation;
  status: ConfirmationStatus;
  contentHash: ContentHash;
  summary: {
    company?: string;
    jobTitle?: string;
    keyFields: Array<{ label: string; value: string }>;
    missingItems: string[];
    attachmentIds: MaterialId[];
    screenshotArtifactIds: ArtifactId[];
    instructions?: string;
  };
  createdAt: IsoTimestamp;
  resolvedAt?: IsoTimestamp;
}

export interface TodoCardRecord {
  id: TodoId;
  taskId: TaskId;
  runId?: RunId;
  reason: WaitingReason;
  summary: string;
  instructions: string;
  status: 'open' | 'resolved' | 'cancelled';
  createdAt: IsoTimestamp;
  resolvedAt?: IsoTimestamp;
}

export interface ActionLedgerRecord {
  id: string;
  taskId: TaskId;
  runId: RunId;
  epoch: Epoch;
  callId?: CallId;
  actionType: string;
  targetSummary: string;
  status: 'pending' | 'dispatched' | 'observed' | 'failed' | 'unknown';
  readbackSummary?: string;
  errorMessage?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface TaskUiProjection {
  taskId: TaskId;
  state: FourAxisState;
  openTodo?: TodoCardRecord;
  pendingQuestion?: QuestionCardRecord;
  pendingConfirmation?: ConfirmationCardRecord;
}
