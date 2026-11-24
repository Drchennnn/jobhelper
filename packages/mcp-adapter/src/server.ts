import type { TaskId } from '@jobhelper/contracts';

export interface TaskMcpEndpointInfo {
  taskId: TaskId;
  url: string;
  authHeaderName: 'x-jobhelper-mcp-token';
}

/**
 * Optional local Streamable HTTP MCP server exposing @jobhelper/tools per taskId
 * with ephemeral loopback port, constant-time token validation, and task-bound session IDs.
 * Implemented in M3.
 */
export interface LocalTaskMcpAdapter {
  start(): Promise<{ port: number }>;
  getTaskEndpoint(taskId: TaskId): TaskMcpEndpointInfo;
  revokeTaskSessions(taskId: TaskId): Promise<void>;
  close(): Promise<void>;
}
