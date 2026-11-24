import type { MainToWorkerMessage, WorkerToMainMessage } from '@jobhelper/contracts';

/**
 * Shared Agent Worker Process Entry (M0 Architecture Placeholder).
 *
 * Planned responsibilities (M2–M3):
 * - Host per-task AgentRuntime instances (@jobhelper/runtime) without leaking context across tasks.
 * - Connect Playwright over ephemeral task-scoped CDP URLs issued by Main Process.
 * - Route model calls via BYOK ModelRouter (@jobhelper/model-router) and tools via UnifiedToolRegistry.
 * - Handle run_start / run_stop / question_reply / message_splice IPC cleanly with ack guarantees.
 */
export interface WorkerProcessHost {
  handleMainMessage(message: MainToWorkerMessage): Promise<void>;
  emitToMain(message: WorkerToMainMessage): void;
}
