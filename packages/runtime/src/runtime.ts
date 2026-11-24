import type {
  AnswerQuestionInput,
  CallId,
  ClientMessageId,
  Epoch,
  MaterialId,
  ModelProviderConfig,
  ModelUsage,
  ProfileVersionId,
  RunEndReason,
  RunId,
  SessionId,
  TaskId,
  TaskKind,
} from '@jobhelper/contracts';
import type { ModelTurnMessage } from '@jobhelper/model-router';

export interface TaskRunInput {
  taskId: TaskId;
  runId: RunId;
  epoch: Epoch;
  sessionId: SessionId;
  role: TaskKind;
  provider: ModelProviderConfig;
  profileVersionId?: ProfileVersionId;
  authorizedMaterialIds: readonly MaterialId[];
  skillCatalogVersion: string;
}

export interface TaskRunOutcome {
  taskId: TaskId;
  runId: RunId;
  epoch: Epoch;
  endReason: RunEndReason;
  usage: ModelUsage;
  error?: { code: string; message: string };
}

/**
 * Context compaction policy: prunes stale AX snapshots / large tool outputs while preserving
 * form progress ledger, confirmed facts, unresolved errors, and active todos.
 */
export interface ContextCompactor {
  compact(messages: readonly ModelTurnMessage[], maxTokensBudget: number): ModelTurnMessage[];
}

/**
 * Coordinates ask_user_question tool waits by (taskId, callId) and late-reply reattachment.
 */
export interface QuestionWaitCoordinator {
  awaitAnswer(
    taskId: TaskId,
    callId: CallId,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ timedOut: boolean; answers?: AnswerQuestionInput['answers'] }>;
  deliverAnswer(taskId: TaskId, callId: CallId, answers: AnswerQuestionInput['answers']): boolean;
}

/**
 * Self-owned per-task Agent Runtime loop contract (replaces vendor-locked Harness).
 * Implemented in M3.
 */
export interface AgentRuntime {
  startRun(input: TaskRunInput): Promise<TaskRunOutcome>;
  stopTask(taskId: TaskId, reason: string): Promise<void>;
  trySpliceUserMessage(taskId: TaskId, clientMessageId: ClientMessageId, text: string): boolean;
}
