import type {
  CallId,
  Epoch,
  MaterialId,
  ProfileVersionId,
  RunId,
  TaskId,
} from './ids.js';
import type { TaskKind } from './state.js';

export type ToolCategory = 'browser' | 'business' | 'coordinator' | 'skill';

export interface ToolCallContext {
  taskId: TaskId;
  runId: RunId;
  epoch: Epoch;
  callId: CallId;
  role: TaskKind;
  profileVersionId?: ProfileVersionId;
  authorizedMaterialIds: readonly MaterialId[];
  /** When true, no further mutating/browser tools may run in this turn. */
  attentionLocked: boolean;
  signal: AbortSignal;
}

export interface ToolExecutionResult<TData = unknown> {
  ok: boolean;
  data?: TData;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  /** Optional multimodal image artifact IDs returned to vision-capable models. */
  imageArtifactIds?: string[];
  /** True when the tool recorded a pending attention/confirmation item and ends the turn. */
  locksAttention?: boolean;
}

export interface ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  category: ToolCategory;
  allowedRoles: readonly TaskKind[];
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  execute: (input: TInput, ctx: ToolCallContext) => Promise<ToolExecutionResult<TOutput>>;
}
