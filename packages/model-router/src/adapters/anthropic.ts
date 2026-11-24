import type { ModelCapabilities, ModelProviderConfig, ModelUsage } from '@jobhelper/contracts';
import { classifyHttpError, ModelRouterError, normalizeFetchFailure } from '../errors.js';
import { runStandardCapabilityProbe } from '../probe.js';
import type {
  ModelGenerateRequest,
  ModelGenerateResponse,
  ModelProviderAdapter,
  ModelToolInvocation,
  ModelTurnMessage,
} from '../router.js';
import { parseSseStream } from '../sse.js';

function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/messages')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function serializeAnthropicPayload(messages: ModelTurnMessage[]): {
  system?: string;
  messages: unknown[];
} {
  const systemParts: string[] = [];
  const out: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => p.text ?? '').join('\n');
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === 'tool') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => p.text ?? '').join('\n');
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content: text,
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (typeof msg.content === 'string' && msg.content) {
        blocks.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(tc.argumentsJson || '{}');
        } catch {
          parsedInput = {};
        }
        blocks.push({
          type: 'tool_use',
          id: tc.callId,
          name: tc.name,
          input: parsedInput,
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
    } else {
      out.push({
        role: msg.role,
        content: msg.content.map((part) => {
          if (part.type === 'image_base64') {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.mimeType ?? 'image/png',
                data: part.dataBase64 ?? '',
              },
            };
          }
          return { type: 'text', text: part.text ?? '' };
        }),
      });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

export class AnthropicAdapter implements ModelProviderAdapter {
  readonly providerType = 'anthropic' as const;

  async probeCapabilities(
    provider: ModelProviderConfig,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ModelCapabilities> {
    return runStandardCapabilityProbe(this, provider, apiKey, signal);
  }

  async generate(request: ModelGenerateRequest, apiKey: string): Promise<ModelGenerateResponse> {
    const url = resolveAnthropicMessagesUrl(request.provider.baseUrl);
    const { system, messages } = serializeAnthropicPayload(request.messages);

    const body: Record<string, unknown> = {
      model: request.provider.modelId,
      max_tokens: 4096,
      stream: true,
      messages,
    };
    if (system) body.system = system;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
      ...(request.provider.customHeaders ?? {}),
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      throw normalizeFetchFailure(error, this.providerType, false, [apiKey]);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw classifyHttpError(response.status, errBody, this.providerType, [apiKey]);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const json = (await response.json()) as {
        stop_reason?: string;
        content?: Array<{
          type: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      let text = '';
      let reasoning = '';
      const toolCalls: ModelToolInvocation[] = [];
      for (const block of json.content ?? []) {
        if (block.type === 'text' && block.text) text += block.text;
        else if (block.type === 'thinking' && block.thinking) reasoning += block.thinking;
        else if (block.type === 'tool_use' && block.name) {
          toolCalls.push({
            callId: block.id ?? `toolu_${toolCalls.length}`,
            name: block.name,
            argumentsJson: JSON.stringify(block.input ?? {}),
          });
        }
      }
      if (text || reasoning) {
        request.onDelta?.({
          textDelta: text || undefined,
          reasoningDelta: reasoning || undefined,
        });
      }
      return {
        text,
        reasoning: reasoning || undefined,
        toolCalls,
        usage: {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
          cachedInputTokens: json.usage?.cache_read_input_tokens,
        },
        finishReason:
          toolCalls.length > 0 || json.stop_reason === 'tool_use'
            ? 'tool_calls'
            : json.stop_reason === 'max_tokens'
              ? 'length'
              : 'stop',
        streamed: false,
      };
    }

    let text = '';
    let reasoning = '';
    let stopReason: string | undefined;
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    const toolBlocks = new Map<number, { callId: string; name: string; argumentsJson: string }>();

    try {
      for await (const evt of parseSseStream(response.body, request.signal)) {
        if (!evt.data.trim()) continue;
        let payload: {
          type?: string;
          index?: number;
          message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } };
          content_block?: { type?: string; id?: string; name?: string };
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            partial_json?: string;
            stop_reason?: string;
          };
          usage?: { output_tokens?: number };
        };
        try {
          payload = JSON.parse(evt.data);
        } catch {
          throw new ModelRouterError('invalid_response', 'Anthropic 流返回了无法解析的 JSON 片段', {
            providerType: this.providerType,
          });
        }

        const eventType = payload.type ?? evt.event;
        if (eventType === 'message_start' && payload.message?.usage) {
          usage.inputTokens = payload.message.usage.input_tokens ?? usage.inputTokens;
          if (payload.message.usage.cache_read_input_tokens !== undefined) {
            usage.cachedInputTokens = payload.message.usage.cache_read_input_tokens;
          }
        } else if (eventType === 'content_block_start' && payload.content_block?.type === 'tool_use') {
          const idx = payload.index ?? toolBlocks.size;
          toolBlocks.set(idx, {
            callId: payload.content_block.id ?? `toolu_${idx}`,
            name: payload.content_block.name ?? '',
            argumentsJson: '',
          });
        } else if (eventType === 'content_block_delta' && payload.delta) {
          if (payload.delta.type === 'text_delta' && payload.delta.text) {
            text += payload.delta.text;
            request.onDelta?.({ textDelta: payload.delta.text });
          } else if (payload.delta.type === 'thinking_delta' && payload.delta.thinking) {
            reasoning += payload.delta.thinking;
            request.onDelta?.({ reasoningDelta: payload.delta.thinking });
          } else if (payload.delta.type === 'input_json_delta' && payload.delta.partial_json) {
            const idx = payload.index ?? 0;
            const entry = toolBlocks.get(idx);
            if (entry) entry.argumentsJson += payload.delta.partial_json;
          }
        } else if (eventType === 'message_delta') {
          if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
          if (payload.usage?.output_tokens !== undefined) {
            usage.outputTokens = payload.usage.output_tokens;
          }
        }
      }
    } catch (error) {
      throw normalizeFetchFailure(error, this.providerType, false, [apiKey]);
    }

    const toolCalls: ModelToolInvocation[] = [...toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => ({
        callId: item.callId,
        name: item.name,
        argumentsJson: item.argumentsJson || '{}',
      }));

    return {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      usage,
      finishReason:
        toolCalls.length > 0 || stopReason === 'tool_use'
          ? 'tool_calls'
          : stopReason === 'max_tokens'
            ? 'length'
            : 'stop',
      streamed: true,
    };
  }
}
