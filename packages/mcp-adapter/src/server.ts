import crypto from 'node:crypto';
import http from 'node:http';
import type {
  CallId,
  Epoch,
  MaterialId,
  ProfileVersionId,
  RunId,
  TaskId,
  TaskKind,
  ToolCallContext,
} from '@jobhelper/contracts';
import type { UnifiedToolRegistry } from '@jobhelper/tools';

export interface TaskMcpEndpointInfo {
  taskId: TaskId;
  url: string;
  authHeaderName: 'x-jobhelper-mcp-token';
  token: string;
}

export interface TaskMcpBinding {
  taskId: TaskId;
  runId: RunId;
  epoch: Epoch;
  role: TaskKind;
  profileVersionId?: ProfileVersionId;
  authorizedMaterialIds: readonly MaterialId[];
  signal: AbortSignal;
}

export interface LocalTaskMcpAdapter {
  start(): Promise<{ port: number }>;
  registerTask(binding: TaskMcpBinding): TaskMcpEndpointInfo;
  getTaskEndpoint(taskId: TaskId): TaskMcpEndpointInfo;
  revokeTaskSessions(taskId: TaskId): Promise<void>;
  close(): Promise<void>;
}

interface ActiveSession {
  sessionId: string;
  taskId: TaskId;
  attentionLocked: boolean;
}

function constantTimeTokenEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Optional local Streamable HTTP MCP adapter exposing `@jobhelper/tools` per taskId.
 * - Random loopback port (127.0.0.1)
 * - Ephemeral 32-byte base64url token verified with timingSafeEqual
 * - Strict `/mcp/<taskId>` routing & task-bound `mcp-session-id`
 * - Zero duplicate tool logic: delegates 100% to `UnifiedToolRegistry`
 */
export class LocalTaskMcpServer implements LocalTaskMcpAdapter {
  private readonly authToken = crypto.randomBytes(32).toString('base64url');
  private readonly bindings = new Map<TaskId, TaskMcpBinding>();
  private readonly sessions = new Map<string, ActiveSession>();
  private server: http.Server | null = null;
  private port = 0;

  constructor(private readonly registry: UnifiedToolRegistry) {}

  async start(): Promise<{ port: number }> {
    if (this.server) return { port: this.port };

    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('LocalTaskMcpServer failed to bind loopback port');
    }
    this.port = addr.port;
    return { port: this.port };
  }

  registerTask(binding: TaskMcpBinding): TaskMcpEndpointInfo {
    this.bindings.set(binding.taskId, binding);
    return this.getTaskEndpoint(binding.taskId);
  }

  getTaskEndpoint(taskId: TaskId): TaskMcpEndpointInfo {
    if (!this.port) throw new Error('LocalTaskMcpServer 尚未启动');
    return {
      taskId,
      url: `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(taskId)}`,
      authHeaderName: 'x-jobhelper-mcp-token',
      token: this.authToken,
    };
  }

  async revokeTaskSessions(taskId: TaskId): Promise<void> {
    this.bindings.delete(taskId);
    for (const [sid, session] of this.sessions.entries()) {
      if (session.taskId === taskId) {
        this.sessions.delete(sid);
      }
    }
  }

  async close(): Promise<void> {
    this.bindings.clear();
    this.sessions.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = 0;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const headerToken = req.headers['x-jobhelper-mcp-token'];
    const tokenStr = Array.isArray(headerToken) ? headerToken[0] ?? '' : headerToken ?? '';
    if (!constantTimeTokenEquals(tokenStr, this.authToken)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized MCP token' }));
      return;
    }

    const match = /^\/mcp\/([^/?#]+)$/.exec(req.url ?? '');
    if (!match || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const taskId = decodeURIComponent(match[1]!) as TaskId;
    const binding = this.bindings.get(taskId);
    if (!binding) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Task MCP context not active: ${taskId}` }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    let rpc: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    if (rpc.method === 'initialize') {
      const sessionId = crypto.randomUUID();
      this.sessions.set(sessionId, { sessionId, taskId, attentionLocked: false });
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          result: {
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'jobhelper-desktop', version: '0.1.0' },
            capabilities: { tools: {} },
          },
        }),
      );
      return;
    }

    // All non-initialize calls require a valid mcp-session-id bound to THIS exact taskId
    const rawSession = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || session.taskId !== taskId) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          error: { code: -32001, message: 'Invalid or cross-task mcp-session-id' },
        }),
      );
      return;
    }

    if (rpc.method === 'tools/list') {
      const tools = this.registry.listForRole(binding.role).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId! });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result: { tools } }));
      return;
    }

    if (rpc.method === 'tools/call') {
      const name = String(rpc.params?.name ?? '');
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
      const ctx: ToolCallContext = {
        taskId: binding.taskId,
        runId: binding.runId,
        epoch: binding.epoch,
        callId: crypto.randomUUID() as CallId,
        role: binding.role,
        profileVersionId: binding.profileVersionId,
        authorizedMaterialIds: binding.authorizedMaterialIds,
        attentionLocked: session.attentionLocked,
        signal: binding.signal,
      };
      const result = await this.registry.invoke(name, args, ctx);
      if (result.locksAttention) {
        session.attentionLocked = true;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId! });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          result: {
            isError: !result.ok,
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId! });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        error: { code: -32601, message: `Unsupported MCP method: ${String(rpc.method)}` },
      }),
    );
  }
}
