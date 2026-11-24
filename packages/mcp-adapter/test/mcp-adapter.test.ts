import { describe, expect, it } from 'vitest';
import type { Epoch, RunId, TaskId } from '@jobhelper/contracts';
import { DefaultToolRegistry } from '@jobhelper/tools';
import { LocalTaskMcpServer } from '../src/index.js';

describe('@jobhelper/mcp-adapter LocalTaskMcpServer', () => {
  it('enforces ephemeral token auth, task-scoped session binding, role filtering, and shared UnifiedToolRegistry execution', async () => {
    const registry = new DefaultToolRegistry();
    registry.register({
      name: 'application_status',
      description: 'List local tasks',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: false,
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, data: [{ taskId: 'app-1', status: 'queued' }] }),
    });
    registry.register({
      name: 'observe',
      description: 'Observe task browser',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => ({ ok: true, data: { observedTask: ctx.taskId } }),
    });

    const server = new LocalTaskMcpServer(registry);
    await server.start();
    try {
      const coordTask = 'coord-1' as TaskId;
      const appTask = 'app-1' as TaskId;
      const ac = new AbortController();

      const coordEndpoint = server.registerTask({
        taskId: coordTask,
        runId: 'run-c' as RunId,
        epoch: 'ep-c' as Epoch,
        role: 'coordinator',
        authorizedMaterialIds: [],
        signal: ac.signal,
      });
      const appEndpoint = server.registerTask({
        taskId: appTask,
        runId: 'run-a' as RunId,
        epoch: 'ep-a' as Epoch,
        role: 'application',
        authorizedMaterialIds: [],
        signal: ac.signal,
      });

      // 1. Missing/bad token -> 401
      const unauth = await fetch(coordEndpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jobhelper-mcp-token': 'wrong' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      expect(unauth.status).toBe(401);

      // 2. Initialize coordinator session
      const initCoord = await fetch(coordEndpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [coordEndpoint.authHeaderName]: coordEndpoint.token,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      expect(initCoord.status).toBe(200);
      const coordSessionId = initCoord.headers.get('mcp-session-id');
      expect(coordSessionId).toBeTruthy();

      // 3. tools/list on coordinator returns ONLY coordinator tools
      const listCoordRes = await fetch(coordEndpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [coordEndpoint.authHeaderName]: coordEndpoint.token,
          'mcp-session-id': coordSessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const listCoordJson = (await listCoordRes.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(listCoordJson.result.tools.map((t) => t.name)).toEqual(['application_status']);

      // 4. Cross-task session reuse on appEndpoint -> 403
      const crossSession = await fetch(appEndpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [appEndpoint.authHeaderName]: appEndpoint.token,
          'mcp-session-id': coordSessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      });
      expect(crossSession.status).toBe(403);

      // 5. Coordinator tools/call executes through shared registry
      const callRes = await fetch(coordEndpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [coordEndpoint.authHeaderName]: coordEndpoint.token,
          'mcp-session-id': coordSessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'application_status', arguments: {} },
        }),
      });
      const callJson = (await callRes.json()) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(callJson.result.isError).toBe(false);
      expect(callJson.result.content[0]?.text).toContain('app-1');

      // 6. Revoking task invalidates endpoint immediately -> 404
      await server.revokeTaskSessions(coordTask);
      const afterRevoke = await fetch(coordEndpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [coordEndpoint.authHeaderName]: coordEndpoint.token,
          'mcp-session-id': coordSessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
      });
      expect(afterRevoke.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
