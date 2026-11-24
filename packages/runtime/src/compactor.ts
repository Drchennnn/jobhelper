import type { ModelTurnMessage } from '@jobhelper/model-router';
import type { ContextCompactor } from './runtime.js';

export interface CompactorOptions {
  /** Number of most recent tool messages to keep in full verbatim form. Default: 2. */
  keepRecentToolOutputs?: number;
  /** Maximum characters allowed for an older compacted tool output. Default: 280. */
  compactedMaxChars?: number;
}

function estimateChars(msg: ModelTurnMessage): number {
  if (typeof msg.content === 'string') return msg.content.length;
  return msg.content.reduce((sum, p) => sum + (p.text?.length ?? 500), 0);
}

function summarizeStaleToolOutput(msg: ModelTurnMessage, maxChars: number): ModelTurnMessage {
  if (typeof msg.content !== 'string') {
    return { ...msg, content: `[已折叠历史工具多模态输出: ${msg.toolName ?? 'tool'}]` };
  }
  const raw = msg.content;
  if (raw.length <= maxChars) return msg;

  // Compact observe snapshots cleanly while keeping URL, generation, and node count
  if (msg.toolName === 'observe') {
    try {
      const parsed = JSON.parse(raw) as {
        data?: { url?: string; title?: string; generation?: number; nodes?: unknown[] };
      };
      if (parsed.data) {
        const summary = `[已折叠陈旧页面观察快照 url=${parsed.data.url ?? ''} title=${parsed.data.title ?? ''} gen=${String(parsed.data.generation ?? '')} nodes=${parsed.data.nodes?.length ?? 0}]`;
        return { ...msg, content: summary };
      }
    } catch {
      // fall through to generic truncation
    }
  }

  return {
    ...msg,
    content: `${raw.slice(0, maxChars)}… [已折叠历史工具输出，原长 ${raw.length} 字符]`,
  };
}

/**
 * Compacts stale page snapshots and large historical tool outputs while preserving:
 * - System prompt
 * - Recent verbatim tool outputs & errors
 * - Confirmed user replies and assistant decisions
 */
export class SlidingWindowContextCompactor implements ContextCompactor {
  private readonly keepRecentToolOutputs: number;
  private readonly compactedMaxChars: number;

  constructor(options?: CompactorOptions) {
    this.keepRecentToolOutputs = options?.keepRecentToolOutputs ?? 2;
    this.compactedMaxChars = options?.compactedMaxChars ?? 280;
  }

  compact(messages: readonly ModelTurnMessage[], maxTokensBudget: number): ModelTurnMessage[] {
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'tool') toolIndices.push(i);
    }

    const keepSet = new Set(toolIndices.slice(-this.keepRecentToolOutputs));
    const result: ModelTurnMessage[] = messages.map((msg, idx) => {
      if (msg.role !== 'tool' || keepSet.has(idx)) {
        return msg;
      }
      // Preserve explicit error results with slightly more context
      if (typeof msg.content === 'string' && msg.content.includes('"ok":false')) {
        return summarizeStaleToolOutput(msg, this.compactedMaxChars * 2);
      }
      return summarizeStaleToolOutput(msg, this.compactedMaxChars);
    });

    // If still above coarse char budget (~3.5 chars/token), drop oldest non-system middle turns
    const charBudget = Math.max(4000, Math.floor(maxTokensBudget * 3.5));
    let totalChars = result.reduce((sum, m) => sum + estimateChars(m), 0);
    while (totalChars > charBudget && result.length > 6) {
      // Keep index 0 (system) and latest 4 messages
      const removed = result.splice(1, 1)[0];
      if (!removed) break;
      totalChars -= estimateChars(removed);
    }

    return result;
  }
}
