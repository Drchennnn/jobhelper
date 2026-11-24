import type { AnswerQuestionInput, CallId, TaskId } from '@jobhelper/contracts';
import type { QuestionWaitCoordinator } from './runtime.js';

interface WaiterEntry {
  resolve: (res: { timedOut: boolean; answers?: AnswerQuestionInput['answers'] }) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort: () => void;
}

/**
 * Coordinates live `ask_user_question` waits keyed by `(taskId, callId)`.
 * Timeout resolves cleanly as `{ timedOut: true }` (never fabricates consent or skips silently).
 */
export class InProcessQuestionWaitCoordinator implements QuestionWaitCoordinator {
  private readonly waiters = new Map<string, WaiterEntry>();

  private key(taskId: TaskId, callId: CallId): string {
    return `${taskId}::${callId}`;
  }

  awaitAnswer(
    taskId: TaskId,
    callId: CallId,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ timedOut: boolean; answers?: AnswerQuestionInput['answers'] }> {
    const k = this.key(taskId, callId);
    if (signal.aborted) {
      return Promise.resolve({ timedOut: true });
    }

    return new Promise((resolve) => {
      const finish = (res: { timedOut: boolean; answers?: AnswerQuestionInput['answers'] }) => {
        const entry = this.waiters.get(k);
        if (!entry) return;
        this.waiters.delete(k);
        clearTimeout(entry.timer);
        entry.cleanupAbort();
        resolve(res);
      };

      const onAbort = () => finish({ timedOut: true });
      signal.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => finish({ timedOut: true }), Math.max(10, timeoutMs));

      this.waiters.set(k, {
        resolve: finish,
        timer,
        cleanupAbort: () => signal.removeEventListener('abort', onAbort),
      });
    });
  }

  deliverAnswer(
    taskId: TaskId,
    callId: CallId,
    answers: AnswerQuestionInput['answers'],
  ): boolean {
    const k = this.key(taskId, callId);
    const entry = this.waiters.get(k);
    if (!entry) return false;
    entry.resolve({ timedOut: false, answers });
    return true;
  }

  cancelTask(taskId: TaskId): void {
    const prefix = `${taskId}::`;
    for (const [k, entry] of this.waiters.entries()) {
      if (k.startsWith(prefix)) {
        entry.resolve({ timedOut: true });
      }
    }
  }
}
