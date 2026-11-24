import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IsoTimestamp, ModelProviderConfig, ProviderId } from '@jobhelper/contracts';
import {
  ByokModelRouter,
  InMemoryCredentialStore,
  runByokBenchmarkMatrix,
} from '../src/index.js';

const NOW = '2026-11-24T12:00:00.000Z' as IsoTimestamp;

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

describe('@jobhelper/model-router M6 BYOK benchmark matrix', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const url = req.url ?? '/';
      const body = await readJson(req);

      if (url === '/openai-accurate/v1/chat/completions') {
        const tools = (body.tools as Array<{ function: { name: string } }>) ?? [];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (tools.length > 0) {
          const toolName = tools[0]!.function.name;
          const args =
            toolName === 'act'
              ? JSON.stringify({ action: 'fill', ref: 'tab-1:e1_1', value: '林星河' })
              : JSON.stringify({ status: 'ok' });
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  delta: {
                    reasoning_content: 'Fill the fullName textbox ref tab-1:e1_1',
                    tool_calls: [
                      { index: 0, id: 'call_bench_1', function: { name: toolName, arguments: args } },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 1200, completion_tokens: 300 },
            })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ finish_reason: 'stop', delta: { content: 'OK' } }],
              usage: { prompt_tokens: 50, completion_tokens: 10 },
            })}\n\n`,
          );
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (url === '/anthropic-drift/v1/messages') {
        const tools = (body.tools as Array<{ name: string }>) ?? [];
        res.writeHead(200, { 'content-type': 'application/json' });
        if (tools.length > 0 && tools[0]!.name === 'act') {
          // Simulates wrong ref picked by model
          res.end(
            JSON.stringify({
              stop_reason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_1',
                  name: 'act',
                  input: { action: 'fill', ref: 'tab-1:e1_2', value: '林星河' },
                },
              ],
              usage: { input_tokens: 900, output_tokens: 200 },
            }),
          );
          return;
        }
        if (tools.length > 0) {
          res.end(
            JSON.stringify({
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'toolu_p', name: tools[0]!.name, input: { status: 'ok' } }],
              usage: { input_tokens: 40, output_tokens: 15 },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'OK' }],
            usage: { input_tokens: 20, output_tokens: 5 },
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('benchmarks multiple BYOK providers, evaluates tool-call accuracy, estimates cost, and formats Markdown', async () => {
    const creds = new InMemoryCredentialStore();
    const p1: ModelProviderConfig = {
      id: 'prov-oa' as ProviderId,
      name: 'DeepSeek Mock',
      providerType: 'openai-compatible',
      baseUrl: `${baseUrl}/openai-accurate/v1`,
      modelId: 'deepseek-chat',
      credentialKey: 'k-oa',
      timeoutMs: 10_000,
      capabilities: { streaming: false, toolCalling: false, vision: false },
      isDefault: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const p2: ModelProviderConfig = {
      id: 'prov-an' as ProviderId,
      name: 'Anthropic Mock',
      providerType: 'anthropic',
      baseUrl: `${baseUrl}/anthropic-drift`,
      modelId: 'claude-3-5-sonnet',
      credentialKey: 'k-an',
      timeoutMs: 10_000,
      capabilities: { streaming: false, toolCalling: false, vision: false },
      isDefault: false,
      createdAt: NOW,
      updatedAt: NOW,
    };

    await creds.setSecret('k-oa', 'sk-test-oa');
    await creds.setSecret('k-an', 'sk-test-an');

    const map = new Map<ProviderId, ModelProviderConfig>([
      [p1.id, p1],
      [p2.id, p2],
    ]);
    const router = new ByokModelRouter(
      {
        getById: (id) => map.get(id) ?? null,
        upsert: (cfg) => {
          map.set(cfg.id, cfg);
        },
      },
      creds,
    );

    const report = await runByokBenchmarkMatrix(router, [
      {
        provider: p1,
        pricing: { currency: 'CNY', inputPer1MTokens: 2, outputPer1MTokens: 8 },
      },
      {
        provider: p2,
        pricing: { currency: 'USD', inputPer1MTokens: 3, outputPer1MTokens: 15 },
      },
    ]);

    expect(report.results).toHaveLength(2);

    const r1 = report.results[0]!;
    expect(r1.capabilities?.streaming).toBe(true);
    expect(r1.capabilities?.toolCalling).toBe(true);
    expect(r1.capabilities?.vision).toBe(true);
    expect(r1.scenarios.find((s) => s.scenario === 'tool_call_form_fill')?.toolCallAccurate).toBe(true);
    expect(r1.totalUsage.inputTokens).toBe(1200);
    expect(r1.totalUsage.outputTokens).toBe(300);
    expect(r1.estimatedCost?.currency).toBe('CNY');
    expect(r1.estimatedCost?.amount).toBeCloseTo(0.0048, 6);

    const r2 = report.results[1]!;
    expect(r2.scenarios.find((s) => s.scenario === 'tool_call_form_fill')?.toolCallAccurate).toBe(false);
    expect(r2.estimatedCost?.currency).toBe('USD');

    expect(report.markdown).toContain('| DeepSeek Mock |');
    expect(report.markdown).toContain('| Anthropic Mock |');
    expect(report.markdown).toContain('¥0.004800');
  });
});
