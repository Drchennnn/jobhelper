import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IsoTimestamp, ModelProviderConfig, ProviderId } from '@jobhelper/contracts';
import { createSqliteStorage } from '@jobhelper/storage';
import {
  ByokModelRouter,
  InMemoryCredentialStore,
  ModelRouterError,
  SafeStorageCredentialStore,
  type SafeStorageBackend,
} from '../src/index.js';

const NOW = '2026-11-24T12:00:00.000Z' as IsoTimestamp;

async function readRequestJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

describe('@jobhelper/model-router', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const url = req.url ?? '/';

      // Error/fault injection endpoints
      if (url === '/error-401/chat/completions') {
        const auth = req.headers.authorization ?? '';
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid key: ${auth}` }));
        return;
      }
      if (url === '/error-429/chat/completions') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      if (url === '/slow/chat/completions') {
        const timer = setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
          }
        }, 2000);
        req.on('close', () => clearTimeout(timer));
        return;
      }

      // OpenAI-compatible streaming endpoint (supports reasoning, tool calls, and rejects vision on /no-vision)
      if (url === '/openai/v1/chat/completions' || url === '/openai-no-vision/v1/chat/completions') {
        const body = await readRequestJson(req);
        const messages = (body.messages as Array<{ content: unknown }>) ?? [];
        const hasImage = messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((p: { type?: string }) => p.type === 'image_url'),
        );
        if (hasImage && url.startsWith('/openai-no-vision')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Vision input not supported by this model' }));
          return;
        }

        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const tools = (body.tools as Array<{ function: { name: string } }>) ?? [];
        if (tools.length > 0) {
          const toolName = tools[0]!.function.name;
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    reasoning_content: 'Need to call tool',
                    tool_calls: [
                      { index: 0, id: 'call_oa_1', function: { name: toolName, arguments: '{"sta' } },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: 'tus":"ok"}' } }],
                  },
                },
              ],
              usage: { prompt_tokens: 21, completion_tokens: 9 },
            })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { reasoning_content: 'thinking...', content: 'O' } }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ finish_reason: 'stop', delta: { content: 'K' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            })}\n\n`,
          );
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Anthropic native streaming endpoint
      if (url === '/anthropic/v1/messages') {
        if (req.headers['x-api-key'] !== 'sk-ant-test-key') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('unauthorized');
          return;
        }
        const body = await readRequestJson(req);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { usage: { input_tokens: 33 } },
          })}\n\n`,
        );
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Checking page' },
          })}\n\n`,
        );
        const tools = (body.tools as Array<{ name: string }>) ?? [];
        if (tools.length > 0) {
          res.write(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'toolu_1', name: tools[0]!.name },
            })}\n\n`,
          );
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"status":"ok"}' },
            })}\n\n`,
          );
          res.write(
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 14 },
            })}\n\n`,
          );
        } else {
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'text_delta', text: 'OK' },
            })}\n\n`,
          );
          res.write(
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 4 },
            })}\n\n`,
          );
        }
        res.end();
        return;
      }

      // Gemini native streaming endpoint
      if (url.startsWith('/gemini/v1beta/models/')) {
        expect(req.headers['x-goog-api-key']).toBe('gem-test-key');
        expect(url).not.toContain('gem-test-key');
        const body = await readRequestJson(req);
        const tools = (body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>) ?? [];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (tools.length > 0) {
          res.write(
            `data: ${JSON.stringify({
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    parts: [
                      { text: 'plan', thought: true },
                      {
                        functionCall: {
                          name: tools[0]!.functionDeclarations[0]!.name,
                          args: { status: 'ok' },
                        },
                      },
                    ],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
            })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }],
              usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
            })}\n\n`,
          );
        }
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('encrypts secrets via SafeStorageBackend, never persists plaintext, and refuses when encryption unavailable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhelper-creds-'));
    const vaultFile = path.join(tmpDir, 'credentials.enc.json');
    try {
      const fakeDpapi: SafeStorageBackend = {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(`ENC::${Buffer.from(plain).toString('hex')}`, 'utf8'),
        decryptString: (buf) => {
          const text = buf.toString('utf8');
          if (!text.startsWith('ENC::')) throw new Error('bad cipher');
          return Buffer.from(text.slice(5), 'hex').toString('utf8');
        },
      };

      const store = new SafeStorageCredentialStore(vaultFile, fakeDpapi);
      await store.setSecret('prov.main', 'sk-super-secret-value-12345');
      expect(await store.hasSecret('prov.main')).toBe(true);
      expect(await store.getSecret('prov.main')).toBe('sk-super-secret-value-12345');

      const rawDisk = fs.readFileSync(vaultFile, 'utf8');
      expect(rawDisk).not.toContain('sk-super-secret-value-12345');

      await store.deleteSecret('prov.main');
      expect(await store.getSecret('prov.main')).toBeNull();

      // Unavailable OS encryption must refuse plaintext fallback
      const brokenStore = new SafeStorageCredentialStore(vaultFile, {
        ...fakeDpapi,
        isEncryptionAvailable: () => false,
      });
      await expect(brokenStore.setSecret('prov.fail', 'secret')).rejects.toThrow(/加密服务不可用/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streams reasoning, text, tool calls, and runs accurate 3-stage capability probe across OpenAI-compatible, Anthropic, and Gemini', async () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    const creds = new InMemoryCredentialStore();
    try {
      const router = new ByokModelRouter(storage.providers, creds);

      const oaProvider: ModelProviderConfig = {
        id: 'p-openai' as ProviderId,
        name: 'DeepSeek Compatible',
        providerType: 'openai-compatible',
        baseUrl: `${baseUrl}/openai-no-vision/v1`,
        modelId: 'deepseek-reasoner',
        credentialKey: 'key.oa',
        timeoutMs: 5000,
        maxContextTokens: 64_000,
        capabilities: { streaming: false, toolCalling: false, vision: false },
        isDefault: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const antProvider: ModelProviderConfig = {
        ...oaProvider,
        id: 'p-ant' as ProviderId,
        name: 'Anthropic Claude',
        providerType: 'anthropic',
        baseUrl: `${baseUrl}/anthropic`,
        modelId: 'claude-sonnet-4-5',
        credentialKey: 'key.ant',
        isDefault: false,
      };
      const gemProvider: ModelProviderConfig = {
        ...oaProvider,
        id: 'p-gem' as ProviderId,
        name: 'Google Gemini',
        providerType: 'gemini',
        baseUrl: `${baseUrl}/gemini`,
        modelId: 'gemini-2.5-pro',
        credentialKey: 'key.gem',
        isDefault: false,
      };

      storage.providers.upsert(oaProvider);
      storage.providers.upsert(antProvider);
      storage.providers.upsert(gemProvider);
      await creds.setSecret('key.oa', 'sk-oa-test-key');
      await creds.setSecret('key.ant', 'sk-ant-test-key');
      await creds.setSecret('key.gem', 'gem-test-key');

      // OpenAI-compatible probe (no vision) persists capabilities cleanly to SQLite
      const oaCaps = await router.probe(oaProvider.id);
      expect(oaCaps.streaming).toBe(true);
      expect(oaCaps.toolCalling).toBe(true);
      expect(oaCaps.vision).toBe(false);
      expect(oaCaps.reasoning).toBe(true);
      expect(storage.providers.getById(oaProvider.id)?.capabilities.toolCalling).toBe(true);

      // Anthropic full probe (supports vision)
      const antCaps = await router.probe(antProvider.id);
      expect(antCaps.streaming).toBe(true);
      expect(antCaps.toolCalling).toBe(true);
      expect(antCaps.vision).toBe(true);

      // Gemini full probe (API key sent via header only, never in URL)
      const gemCaps = await router.probe(gemProvider.id);
      expect(gemCaps.streaming).toBe(true);
      expect(gemCaps.toolCalling).toBe(true);
      expect(gemCaps.vision).toBe(true);

      // Direct generate streaming delta check on OpenAI-compatible
      const streamedDeltas: string[] = [];
      const genRes = await router.generate({
        provider: oaProvider,
        messages: [{ role: 'user', content: 'ping' }],
        tools: [
          {
            name: 'observe',
            description: 'Observe page',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        signal: new AbortController().signal,
        onDelta: (d) => {
          if (d.reasoningDelta) streamedDeltas.push(`R:${d.reasoningDelta}`);
          if (d.textDelta) streamedDeltas.push(`T:${d.textDelta}`);
        },
      });
      expect(genRes.finishReason).toBe('tool_calls');
      expect(genRes.toolCalls).toEqual([
        { callId: 'call_oa_1', name: 'observe', argumentsJson: '{"status":"ok"}' },
      ]);
      expect(genRes.usage).toEqual({ inputTokens: 21, outputTokens: 9 });
      expect(streamedDeltas).toContain('R:Need to call tool');
    } finally {
      storage.close();
    }
  });

  it('classifies 401/429/timeout/abort errors accurately and redacts API keys from error messages', async () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    const creds = new InMemoryCredentialStore();
    try {
      const router = new ByokModelRouter(storage.providers, creds);
      const secret = 'sk-leak-check-999999';
      await creds.setSecret('key.err', secret);

      const makeProvider = (id: string, suffix: string, timeoutMs = 3000): ModelProviderConfig => ({
        id: id as ProviderId,
        name: id,
        providerType: 'openai-compatible',
        baseUrl: `${baseUrl}/${suffix}`,
        modelId: 'test',
        credentialKey: 'key.err',
        timeoutMs,
        maxContextTokens: 32_000,
        capabilities: { streaming: true, toolCalling: true, vision: false },
        isDefault: false,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // 401 auth failure redacts key
      try {
        await router.generate({
          provider: makeProvider('p401', 'error-401'),
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          signal: new AbortController().signal,
        });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ModelRouterError);
        const routerErr = err as ModelRouterError;
        expect(routerErr.code).toBe('auth_failed');
        expect(routerErr.retryable).toBe(false);
        expect(routerErr.message).not.toContain(secret);
        expect(routerErr.message).toContain('[REDACTED]');
      }

      // 429 rate limited
      await expect(
        router.generate({
          provider: makeProvider('p429', 'error-429'),
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });

      // Timeout
      await expect(
        router.generate({
          provider: makeProvider('pslow', 'slow', 150),
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'timeout', retryable: true });

      // External AbortSignal cancellation
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      await expect(
        router.generate({
          provider: makeProvider('pabort', 'slow', 5000),
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          signal: ac.signal,
        }),
      ).rejects.toMatchObject({ code: 'aborted', retryable: false });
    } finally {
      storage.close();
    }
  });
});
