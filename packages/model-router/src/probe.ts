import type { IsoTimestamp, ModelCapabilities, ModelProviderConfig } from '@jobhelper/contracts';
import type { ModelProviderAdapter, ModelToolSchema } from './router.js';

/** Valid 1x1 transparent PNG used for lightweight BYOK vision capability probing. */
export const PROBE_PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const PROBE_TOOL: ModelToolSchema = {
  name: 'jobhelper_capability_ping',
  description: 'Connectivity and tool-calling capability verification tool.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Return "ok".' },
    },
    required: ['status'],
  },
};

/**
 * Shared 3-stage capability probe (streaming -> tool_calling -> vision) used across all adapters.
 */
export async function runStandardCapabilityProbe(
  adapter: ModelProviderAdapter,
  provider: ModelProviderConfig,
  apiKey: string,
  signal: AbortSignal,
): Promise<ModelCapabilities> {
  const probedAt = new Date().toISOString() as IsoTimestamp;

  // Stage 1: Basic reachability & streaming
  let deltaCount = 0;
  const basic = await adapter.generate(
    {
      provider,
      messages: [
        { role: 'user', content: 'Reply with a single word: OK' },
      ],
      tools: [],
      signal,
      onDelta: (d) => {
        if (d.textDelta || d.reasoningDelta) deltaCount++;
      },
    },
    apiKey,
  );
  const streaming = basic.streamed || deltaCount > 0;

  // Stage 2: Tool calling
  let toolCalling = false;
  try {
    const toolRes = await adapter.generate(
      {
        provider,
        messages: [
          {
            role: 'user',
            content: 'You MUST call the jobhelper_capability_ping tool with {"status":"ok"}.',
          },
        ],
        tools: [PROBE_TOOL],
        signal,
      },
      apiKey,
    );
    toolCalling = toolRes.toolCalls.some((call) => call.name === PROBE_TOOL.name);
  } catch {
    toolCalling = false;
  }

  // Stage 3: Vision (multimodal base64 image input)
  let vision = false;
  try {
    const visionRes = await adapter.generate(
      {
        provider,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Confirm you received this image by replying OK.' },
              {
                type: 'image_base64',
                mimeType: 'image/png',
                dataBase64: PROBE_PNG_1X1_BASE64,
              },
            ],
          },
        ],
        tools: [],
        signal,
      },
      apiKey,
    );
    vision = visionRes.finishReason !== 'error' && visionRes.text.length >= 0;
  } catch {
    vision = false;
  }

  return {
    streaming,
    toolCalling,
    vision,
    reasoning: Boolean(basic.reasoning && basic.reasoning.length > 0),
    maxContextTokens: provider.maxContextTokens,
    probedAt,
  };
}
