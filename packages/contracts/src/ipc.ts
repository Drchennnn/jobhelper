import type {
  ClientMessageId,
  ConfirmationId,
  Epoch,
  MaterialId,
  PositionId,
  ProfileId,
  ProviderId,
  QuestionId,
  RunId,
  TaskId,
  TabId,
} from './ids.js';
import type { TaskRecord } from './state.js';
import type { ViewportRect } from './browser.js';
import type { StreamDeltaEvent, TaskEventRecord } from './events.js';

/**
 * Typed IPC channel catalog between Renderer (workbench) and Electron Main Process.
 */
export interface StartApplicationInput {
  applyUrl: string;
  positionId?: PositionId;
  profileId?: ProfileId;
  materialIds?: MaterialId[];
  note?: string;
  originConversationId?: TaskId;
}

export interface SendMessageInput {
  taskId: TaskId;
  clientMessageId: ClientMessageId;
  text: string;
  materialIds?: MaterialId[];
}

export interface AnswerQuestionInput {
  taskId: TaskId;
  questionCardId: string;
  answers: Array<{
    questionId: QuestionId;
    value: string;
    saveToProfile: boolean;
  }>;
}

export interface ResolveConfirmationInput {
  taskId: TaskId;
  confirmationId: ConfirmationId;
  decision: 'approve' | 'decline' | 'manual_submitted';
}

export interface BrowserSurfaceLayoutInput {
  taskId: TaskId | null;
  visible: boolean;
  bounds: ViewportRect;
}

export interface RendererToMainIpc {
  'tasks:list': () => Promise<TaskRecord[]>;
  'tasks:startApplication': (input: StartApplicationInput) => Promise<{ taskId: TaskId; reused: boolean }>;
  'tasks:sendMessage': (input: SendMessageInput) => Promise<{ accepted: boolean; duplicated: boolean }>;
  'tasks:takeover': (input: { taskId: TaskId }) => Promise<void>;
  'tasks:resumeCheck': (input: { taskId: TaskId }) => Promise<void>;
  'tasks:close': (input: { taskId: TaskId }) => Promise<void>;
  'tasks:answerQuestion': (input: AnswerQuestionInput) => Promise<void>;
  'tasks:resolveConfirmation': (input: ResolveConfirmationInput) => Promise<void>;
  'tasks:events': (input: { taskId: TaskId; afterSeq?: number }) => Promise<TaskEventRecord[]>;
  'browser:syncSurface': (input: BrowserSurfaceLayoutInput) => Promise<void>;
  'browser:navigate': (input: { taskId: TaskId; tabId: TabId; url: string }) => Promise<void>;
  'browser:detachWindow': (input: { taskId: TaskId }) => Promise<void>;
  'providers:probe': (input: { providerId: ProviderId }) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Main Process <-> Shared Agent Worker protocol messages.
 */
export type MainToWorkerMessage =
  | { type: 'run_start'; taskId: TaskId; runId: RunId; epoch: Epoch }
  | { type: 'run_stop'; taskId: TaskId; reason: string }
  | { type: 'question_reply'; taskId: TaskId; questionCardId: string; answers: AnswerQuestionInput['answers'] }
  | { type: 'message_splice'; taskId: TaskId; clientMessageId: ClientMessageId; text: string }
  | { type: 'rpc_reply'; requestId: string; ok: boolean; data?: unknown; error?: string };

export type WorkerToMainMessage =
  | { type: 'worker_ready' }
  | { type: 'stream_delta'; delta: StreamDeltaEvent }
  | { type: 'run_finished'; taskId: TaskId; runId: RunId; epoch: Epoch; endReason: string; error?: string }
  | { type: 'run_stopped_ack'; taskId: TaskId }
  | { type: 'rpc_request'; requestId: string; taskId: TaskId; epoch: Epoch; method: string; params: unknown };
