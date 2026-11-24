import crypto from 'node:crypto';
import type {
  CallId,
  ClientMessageId,
  IsoTimestamp,
  ModelUsage,
  RunEndReason,
  StreamDeltaEvent,
  TaskId,
  ToolCallContext,
  ToolExecutionResult,
} from '@jobhelper/contracts';
import type {
  ModelRouter,
  ModelToolSchema,
  ModelTurnMessage,
} from '@jobhelper/model-router';
import type { UnifiedToolRegistry } from '@jobhelper/tools';
import { SlidingWindowContextCompactor } from './compactor.js';
import { systemPromptForRole } from './prompts.js';
import type { AgentRuntime, ContextCompactor, TaskRunInput, TaskRunOutcome } from './runtime.js';

export interface RuntimeEventSink {
  onStreamDelta?: (delta: StreamDeltaEvent) => void;
  onAssistantMessage?: (event: {
    taskId: TaskId;
    runId: TaskRunInput['runId'];
    epoch: TaskRunInput['epoch'];
    text: string;
    reasoning?: string;
    partial?: boolean;
    createdAt: IsoTimestamp;
  }) => void;
  onToolCall?: (event: {
    taskId: TaskId;
    runId: TaskRunInput['runId'];
    epoch: TaskRunInput['epoch'];
    callId: CallId;
    toolName: string;
    argumentsJson: string;
    createdAt: IsoTimestamp;
  }) => void;
  onToolResult?: (event: {
    taskId: TaskId;
    runId: TaskRunInput['runId'];
    epoch: TaskRunInput['epoch'];
    callId: CallId;
    toolName: string;
    result: ToolExecutionResult;
    createdAt: IsoTimestamp;
  }) => void;
}

export interface LocalAgentRuntimeOptions {
  modelRouter: ModelRouter;
  tools: UnifiedToolRegistry;
  compactor?: ContextCompactor;
  sink?: RuntimeEventSink;
  maxStepsPerRun?: number;
  /** Optional hook to supply initial user message(s) for a new run. */
  getPendingUserPrompts?: (taskId: TaskId) => string[];
}

interface ActiveRunState {
  controller: AbortController;
  splicedMessages: Array<{ clientMessageId: ClientMessageId; text: string }>;
}

/**
 * Self-owned lightweight TypeScript Agent Runtime (ADR-0002).
 * Features:
 * - Per-task persistent session history decoupled from SQLite business SoT
 * - Context compaction keeping stale snapshots bounded
 * - Streaming text/reasoning delta emission with partial preservation on user stop
 * - Attention-lock propagation ending turn cleanly when user action/confirmation is registered
 * - Safe turn-boundary message splicing for non-attachment user follow-ups
 */
export class LocalAgentRuntime implements AgentRuntime {
  private readonly sessions = new Map<TaskId, ModelTurnMessage[]>();
  private readonly activeRuns = new Map<TaskId, ActiveRunState>();
  private readonly compactor: ContextCompactor;
  private readonly maxStepsPerRun: number;

  constructor(private readonly options: LocalAgentRuntimeOptions) {
    this.compactor = options.compactor ?? new SlidingWindowContextCompactor();
    this.maxStepsPerRun = options.maxStepsPerRun ?? 24;
  }

  getSessionMessages(taskId: TaskId): readonly ModelTurnMessage[] {
    return this.sessions.get(taskId) ?? [];
  }

  appendUserPrompt(taskId: TaskId, text: string): void {
    const history = this.ensureSession(taskId, 'application');
    history.push({ role: 'user', content: text });
  }

  private ensureSession(taskId: TaskId, role: TaskRunInput['role']): ModelTurnMessage[] {
    let history = this.sessions.get(taskId);
    if (!history) {
      history = [{ role: 'system', content: systemPromptForRole(role) }];
      this.sessions.set(taskId, history);
    }
    return history;
  }

  trySpliceUserMessage(taskId: TaskId, clientMessageId: ClientMessageId, text: string): boolean {
    const active = this.activeRuns.get(taskId);
    if (!active || active.controller.signal.aborted) return false;
    active.splicedMessages.push({ clientMessageId, text });
    return true;
  }

  async stopTask(taskId: TaskId, reason: string): Promise<void> {
    const active = this.activeRuns.get(taskId);
    if (!active) return;
    active.controller.abort(new Error(reason));
  }

  async startRun(input: TaskRunInput): Promise<TaskRunOutcome> {
    if (input.role === 'application' && !input.provider.capabilities.toolCalling) {
      return {
        taskId: input.taskId,
        runId: input.runId,
        epoch: input.epoch,
        endReason: 'model_error',
        usage: { inputTokens: 0, outputTokens: 0 },
        error: {
          code: 'UNSUPPORTED_TOOL_CALLING',
          message: `所选模型 "${input.provider.name}" 不支持工具调用（tool_calling），无法运行投递任务`,
        },
      };
    }

    const controller = new AbortController();
    const runState: ActiveRunState = { controller, splicedMessages: [] };
    this.activeRuns.set(input.taskId, runState);

    const history = this.ensureSession(input.taskId, input.role);
    const initialPrompts = this.options.getPendingUserPrompts?.(input.taskId) ?? [];
    for (const p of initialPrompts) {
      history.push({ role: 'user', content: p });
    }
    if (history.length === 1) {
      history.push({
        role: 'user',
        content:
          input.role === 'application'
            ? '请先读取绑定档案并观察当前招聘页面，按规范执行本轮任务。'
            : '请协助处理用户当前求职需求。',
      });
    }

    const roleTools = this.options.tools.listForRole(input.role);
    const toolSchemas: ModelToolSchema[] = roleTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const totalUsage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    let attentionLocked = false;
    let endReason: RunEndReason = 'completed';
    let runError: { code: string; message: string } | undefined;

    try {
      for (let step = 0; step < this.maxStepsPerRun; step++) {
        if (controller.signal.aborted) {
          endReason = 'stopped_by_user';
          break;
        }

        // Drain any spliced user messages at a clean turn boundary
        while (runState.splicedMessages.length > 0) {
          const spliced = runState.splicedMessages.shift()!;
          history.push({ role: 'user', content: spliced.text });
        }

        const compacted = this.compactor.compact(history, input.provider.maxContextTokens);
        const attemptId = crypto.randomUUID();
        let partialText = '';
        let partialReasoning = '';

        let response;
        try {
          response = await this.options.modelRouter.generate({
            provider: input.provider,
            messages: compacted,
            tools: toolSchemas,
            signal: controller.signal,
            onDelta: (delta) => {
              if (delta.textDelta) partialText += delta.textDelta;
              if (delta.reasoningDelta) partialReasoning += delta.reasoningDelta;
              this.options.sink?.onStreamDelta?.({
                taskId: input.taskId,
                runId: input.runId,
                epoch: input.epoch,
                attemptId,
                textDelta: delta.textDelta ?? '',
                reasoningDelta: delta.reasoningDelta ?? '',
                done: false,
              });
            },
          });
        } catch (error) {
          // Preserve streamed partial text/reasoning when stopped mid-generation
          if (partialText || partialReasoning) {
            const now = new Date().toISOString() as IsoTimestamp;
            this.options.sink?.onAssistantMessage?.({
              taskId: input.taskId,
              runId: input.runId,
              epoch: input.epoch,
              text: partialText,
              reasoning: partialReasoning || undefined,
              partial: true,
              createdAt: now,
            });
          }
          if (controller.signal.aborted) {
            endReason = 'stopped_by_user';
            break;
          }
          endReason = 'model_error';
          runError = {
            code:
              error && typeof error === 'object' && 'code' in error
                ? String((error as { code: unknown }).code)
                : 'MODEL_ERROR',
            message: error instanceof Error ? error.message : String(error),
          };
          break;
        }

        this.options.sink?.onStreamDelta?.({
          taskId: input.taskId,
          runId: input.runId,
          epoch: input.epoch,
          attemptId,
          textDelta: '',
          reasoningDelta: '',
          done: true,
        });

        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;
        if (response.usage.reasoningTokens) {
          totalUsage.reasoningTokens =
            (totalUsage.reasoningTokens ?? 0) + response.usage.reasoningTokens;
        }

        const now = new Date().toISOString() as IsoTimestamp;
        history.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
        });

        if (response.text || response.reasoning) {
          this.options.sink?.onAssistantMessage?.({
            taskId: input.taskId,
            runId: input.runId,
            epoch: input.epoch,
            text: response.text,
            reasoning: response.reasoning,
            createdAt: now,
          });
        }

        if (response.toolCalls.length === 0) {
          endReason = attentionLocked ? 'waiting_user' : 'completed';
          break;
        }

        // Execute tool calls sequentially so attention locks take effect immediately
        for (const call of response.toolCalls) {
          if (controller.signal.aborted) {
            endReason = 'stopped_by_user';
            break;
          }

          const callId = call.callId as CallId;
          this.options.sink?.onToolCall?.({
            taskId: input.taskId,
            runId: input.runId,
            epoch: input.epoch,
            callId,
            toolName: call.name,
            argumentsJson: call.argumentsJson,
            createdAt: new Date().toISOString() as IsoTimestamp,
          });

          let parsedArgs: Record<string, unknown> = {};
          let parseFailed: string | null = null;
          try {
            parsedArgs = call.argumentsJson
              ? (JSON.parse(call.argumentsJson) as Record<string, unknown>)
              : {};
          } catch {
            parseFailed = `无法解析工具参数 JSON: ${call.argumentsJson.slice(0, 120)}`;
          }

          const toolCtx: ToolCallContext = {
            taskId: input.taskId,
            runId: input.runId,
            epoch: input.epoch,
            callId,
            role: input.role,
            profileVersionId: input.profileVersionId,
            authorizedMaterialIds: input.authorizedMaterialIds,
            attentionLocked,
            signal: controller.signal,
          };

          const result: ToolExecutionResult = parseFailed
            ? { ok: false, error: { code: 'INVALID_JSON_ARGS', message: parseFailed } }
            : await this.options.tools.invoke(call.name, parsedArgs, toolCtx);

          if (result.locksAttention) {
            attentionLocked = true;
          }

          this.options.sink?.onToolResult?.({
            taskId: input.taskId,
            runId: input.runId,
            epoch: input.epoch,
            callId,
            toolName: call.name,
            result,
            createdAt: new Date().toISOString() as IsoTimestamp,
          });

          history.push({
            role: 'tool',
            toolCallId: call.callId,
            toolName: call.name,
            content: JSON.stringify(result),
          });
        }

        if (controller.signal.aborted) {
          endReason = 'stopped_by_user';
          break;
        }

        if (attentionLocked) {
          endReason = 'waiting_user';
          break;
        }
      }
    } finally {
      if (this.activeRuns.get(input.taskId) === runState) {
        this.activeRuns.delete(input.taskId);
      }
    }

    return {
      taskId: input.taskId,
      runId: input.runId,
      epoch: input.epoch,
      endReason,
      usage: totalUsage,
      error: runError,
    };
  }
}
