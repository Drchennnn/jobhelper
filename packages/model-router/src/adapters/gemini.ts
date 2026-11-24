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

function resolveGeminiStreamUrl(baseUrl: string, modelId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const prefix = trimmed.endsWith('/v1beta') ? trimmed : `${trimmed}/v1beta`;
  return `${prefix}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
}

function serializeGeminiPayload(messages: ModelTurnMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: unknown[];
} {
  const systemParts: Array<{ text: string }> = [];
  const contents: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => p.text ?? '').join('\n');
      if (text) systemParts.push({ text });
      continue;
    }

    if (msg.role === 'tool') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => p.text ?? '').join('\n');
      let parsed: unknown = { result: text };
      try {
        const obj = JSON.parse(text) as unknown;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj;
      } catch {
        // wrap non-object tool output
      }
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: msg.toolName ?? 'tool',
              response: parsed,
            },
          },
        ],
      });
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: unknown[] = [];

    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else {
      for (const part of msg.content) {
        if (part.type === 'image_base64') {
          parts.push({
            inlineData: {
              mimeType: part.mimeType ?? 'image/png',
              data: part.dataBase64 ?? '',
            },
          });
        } else if (part.text) {
          parts.push({ text: part.text });
        }
      }
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.argumentsJson || '{}');
        } catch {
          args = {};
        }
        parts.push({
          functionCall: {
            name: tc.name,
            args,
          },
        });
      }
    }

    contents.push({ role, parts });
  }

  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
    contents,
  };
}

interface GeminiCandidateChunk {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: { id?: string; name?: string; args?: unknown };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export class GeminiAdapter implements ModelProviderAdapter {
  readonly providerType = 'gemini' as const;

  async probeCapabilities(
    provider: ModelProviderConfig,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ModelCapabilities> {
    return runStandardCapabilityProbe(this, provider, apiKey, signal);
  }

  async generate(request: ModelGenerateRequest, apiKey: string): Promise<ModelGenerateResponse> {
    const url = resolveGeminiStreamUrl(request.provider.baseUrl, request.provider.modelId);
    const { systemInstruction, contents } = serializeGeminiPayload(request.messages);

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      ];
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
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

    let text = '';
    let reasoning = '';
    let finishReasonRaw: string | undefined;
    const toolCalls: ModelToolInvocation[] = [];
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };

    const consumeChunk = (chunk: GeminiCandidateChunk) => {
      if (chunk.usageMetadata) {
        usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? usage.inputTokens;
        usage.outputTokens = chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens;
        if (chunk.usageMetadata.thoughtsTokenCount !== undefined) {
          usage.reasoningTokens = chunk.usageMetadata.thoughtsTokenCount;
        }
        if (chunk.usageMetadata.cachedContentTokenCount !== undefined) {
          usage.cachedInputTokens = chunk.usageMetadata.cachedContentTokenCount;
        }
      }
      const cand = chunk.candidates?.[0];
      if (!cand) return;
      if (cand.finishReason) finishReasonRaw = cand.finishReason;
      for (const part of cand.content?.parts ?? []) {
        if (part.text) {
          if (part.thought) {
            reasoning += part.text;
            request.onDelta?.({ reasoningDelta: part.text });
          } else {
            text += part.text;
            request.onDelta?.({ textDelta: part.text });
          }
        } else if (part.functionCall?.name) {
          toolCalls.push({
            callId: part.functionCall.id ?? `gemini_call_${toolCalls.length}`,
            name: part.functionCall.name,
            argumentsJson: JSON.stringify(part.functionCall.args ?? {}),
          });
        }
      }
    };

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const json = (await response.json()) as GeminiCandidateChunk | GeminiCandidateChunk[];
      const list = Array.isArray(json) ? json : [json];
      for (const item of list) consumeChunk(item);
      return {
        text,
        reasoning: reasoning || undefined,
        toolCalls,
        usage,
        finishReason:
          toolCalls.length > 0
            ? 'tool_calls'
            : finishReasonRaw === 'MAX_TOKENS'
              ? 'length'
              : 'stop',
        streamed: false,
      };
    }

    try {
      for await (const evt of parseSseStream(response.body, request.signal)) {
        if (!evt.data.trim()) continue;
        let chunk: GeminiCandidateChunk;
        try {
          chunk = JSON.parse(evt.data);
        } catch {
          throw new ModelRouterError('invalid_response', 'Gemini 流返回了无法解析的 JSON 片段', {
            providerType: this.providerType,
          });
        }
        consumeChunk(chunk);
      }
    } catch (error) {
      throw normalizeFetchFailure(error, this.providerType, false, [apiKey]);
    }

    return {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      usage,
      finishReason:
        toolCalls.length > 0
          ? 'tool_calls'
          : finishReasonRaw === 'MAX_TOKENS'
            ? 'length'
            : 'stop',
      streamed: true,
    };
  }
}
