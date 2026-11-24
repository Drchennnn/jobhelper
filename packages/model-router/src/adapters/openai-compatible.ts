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

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function serializeMessages(messages: ModelTurnMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      const contentText =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => p.text ?? '').join('\n');
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
        content: contentText,
      };
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content || null : null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.callId,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.argumentsJson,
          },
        })),
      };
    }

    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    return {
      role: msg.role,
      content: msg.content.map((part) => {
        if (part.type === 'image_base64') {
          const mime = part.mimeType ?? 'image/png';
          return {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${part.dataBase64 ?? ''}` },
          };
        }
        return { type: 'text', text: part.text ?? '' };
      }),
    };
  });
}

function mapFinishReason(raw?: string | null): ModelGenerateResponse['finishReason'] {
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool_calls';
  if (raw === 'length') return 'length';
  return 'stop';
}

export class OpenAiCompatibleAdapter implements ModelProviderAdapter {
  readonly providerType = 'openai-compatible' as const;

  async probeCapabilities(
    provider: ModelProviderConfig,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ModelCapabilities> {
    return runStandardCapabilityProbe(this, provider, apiKey, signal);
  }

  async generate(request: ModelGenerateRequest, apiKey: string): Promise<ModelGenerateResponse> {
    const url = resolveChatCompletionsUrl(request.provider.baseUrl);
    const body: Record<string, unknown> = {
      model: request.provider.modelId,
      messages: serializeMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(request.provider.customHeaders ?? {}),
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    let response: Response;
    const postBody = async (payload: Record<string, unknown>): Promise<Response> => {
      try {
        return await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: request.signal,
        });
      } catch (error) {
        throw normalizeFetchFailure(error, this.providerType, false, [apiKey]);
      }
    };

    response = await postBody(body);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      // Graceful fallback for OpenAI-compatible gateways that reject `stream_options` with HTTP 400
      if (response.status === 400 && /stream_options|unknown|unrecognized/i.test(errBody)) {
        const fallbackBody = { ...body };
        delete fallbackBody.stream_options;
        const retryRes = await postBody(fallbackBody);
        if (retryRes.ok) {
          response = retryRes;
        } else {
          const retryErr = await retryRes.text().catch(() => '');
          throw classifyHttpError(retryRes.status, retryErr, this.providerType, [apiKey]);
        }
      } else {
        throw classifyHttpError(response.status, errBody, this.providerType, [apiKey]);
      }
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const json = (await response.json()) as {
        choices?: Array<{
          finish_reason?: string;
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      const choice = json.choices?.[0];
      const text = choice?.message?.content ?? '';
      const reasoning = choice?.message?.reasoning_content ?? undefined;
      if (text || reasoning) {
        request.onDelta?.({ textDelta: text || undefined, reasoningDelta: reasoning });
      }
      const toolCalls: ModelToolInvocation[] = (choice?.message?.tool_calls ?? []).map((tc, i) => ({
        callId: tc.id ?? `call_${i}`,
        name: tc.function?.name ?? '',
        argumentsJson: tc.function?.arguments ?? '{}',
      }));
      return {
        text,
        reasoning,
        toolCalls,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
          reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens,
          cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens,
        },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(choice?.finish_reason),
        streamed: false,
      };
    }

    let text = '';
    let reasoning = '';
    let finishReasonRaw: string | null | undefined;
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    const toolAcc = new Map<number, { callId: string; name: string; argumentsJson: string }>();

    try {
      for await (const evt of parseSseStream(response.body, request.signal)) {
        if (evt.data === '[DONE]') break;
        if (!evt.data.trim()) continue;
        let chunk: {
          choices?: Array<{
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              reasoning?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
            prompt_tokens_details?: { cached_tokens?: number };
          };
        };
        try {
          chunk = JSON.parse(evt.data);
        } catch {
          throw new ModelRouterError('invalid_response', 'OpenAI 兼容流返回了无法解析的 JSON 片段', {
            providerType: this.providerType,
          });
        }

        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
          if (chunk.usage.completion_tokens_details?.reasoning_tokens !== undefined) {
            usage.reasoningTokens = chunk.usage.completion_tokens_details.reasoning_tokens;
          }
          if (chunk.usage.prompt_tokens_details?.cached_tokens !== undefined) {
            usage.cachedInputTokens = chunk.usage.prompt_tokens_details.cached_tokens;
          }
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReasonRaw = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        const textDelta = delta.content ?? '';
        const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? '';
        if (textDelta) text += textDelta;
        if (reasoningDelta) reasoning += reasoningDelta;
        if (textDelta || reasoningDelta) {
          request.onDelta?.({
            textDelta: textDelta || undefined,
            reasoningDelta: reasoningDelta || undefined,
          });
        }

        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const existing = toolAcc.get(idx) ?? {
            callId: tc.id ?? `call_${idx}`,
            name: '',
            argumentsJson: '',
          };
          if (tc.id) existing.callId = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.argumentsJson += tc.function.arguments;
          toolAcc.set(idx, existing);
        }
      }
    } catch (error) {
      throw normalizeFetchFailure(error, this.providerType, false, [apiKey]);
    }

    const toolCalls: ModelToolInvocation[] = [...toolAcc.entries()]
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
      finishReason: toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(finishReasonRaw),
      streamed: true,
    };
  }
}
