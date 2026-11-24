import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { TaskEventRecord } from '@jobhelper/contracts';

interface EventTimelineProps {
  events: TaskEventRecord[];
  streamingText?: string;
  streamingReasoning?: string;
}

function ToolCallItem({
  toolName,
  argumentsJson,
  result,
}: {
  toolName: string;
  argumentsJson?: string;
  result?: { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown };
}) {
  const [open, setOpen] = useState(false);
  const failed = result?.ok === false;

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 text-xs ${
        failed ? 'border-rose-200 bg-rose-50/70' : 'border-slate-200 bg-slate-50/80'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-1.5 font-medium text-slate-700">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Wrench className="h-3.5 w-3.5 text-slate-500" />
          <span className="font-mono">{toolName}</span>
        </span>
        {result && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              failed ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'
            }`}
          >
            {failed ? result.error?.code ?? '失败' : '成功'}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5 border-t border-slate-200/80 pt-2 font-mono text-[11px]">
          {argumentsJson && (
            <div>
              <div className="text-[10px] font-sans text-slate-400">入参</div>
              <pre className="mt-0.5 max-h-36 overflow-auto rounded bg-white p-2 text-slate-700">
                {argumentsJson}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-[10px] font-sans text-slate-400">结果</div>
              <pre className="mt-0.5 max-h-44 overflow-auto rounded bg-white p-2 text-slate-700">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function EventTimeline({ events, streamingText, streamingReasoning }: EventTimelineProps) {
  // Pair tool_call with its corresponding tool_result by callId (preserving order even if result arrives first)
  const toolResultsByCallId = new Map<string, Record<string, unknown>>();
  for (const ev of events) {
    if (ev.type === 'tool_result' && typeof ev.payload.callId === 'string') {
      toolResultsByCallId.set(ev.payload.callId, ev.payload);
    }
  }

  return (
    <div className="space-y-2.5">
      {events.length === 0 && !streamingText && (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white p-4 text-center text-xs text-slate-400">
          暂无对话与执行事件，发送指令或启动任务后将实时记录在此。
        </div>
      )}

      {events.map((ev) => {
        if (ev.type === 'user_message') {
          return (
            <div key={ev.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-indigo-600 px-3.5 py-2 text-xs leading-relaxed text-white shadow-xs">
                {String(ev.payload.text ?? '')}
              </div>
            </div>
          );
        }

        if (ev.type === 'assistant_message') {
          const text = String(ev.payload.text ?? '');
          const reasoning = typeof ev.payload.reasoning === 'string' ? ev.payload.reasoning : '';
          const partial = Boolean(ev.payload.partial);
          return (
            <div key={ev.id} className="rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-xs">
              {reasoning && (
                <details className="mb-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
                  <summary className="cursor-pointer font-medium">推理过程</summary>
                  <div className="mt-1 whitespace-pre-wrap">{reasoning}</div>
                </details>
              )}
              <div className="whitespace-pre-wrap leading-relaxed text-slate-800">{text}</div>
              {partial && (
                <div className="mt-1 text-[10px] text-amber-600">（已在停止时保留已生成的片段）</div>
              )}
            </div>
          );
        }

        if (ev.type === 'tool_call') {
          const callId = String(ev.payload.callId ?? '');
          const matchedResult = toolResultsByCallId.get(callId);
          return (
            <ToolCallItem
              key={ev.id}
              toolName={String(ev.payload.toolName ?? 'tool')}
              argumentsJson={typeof ev.payload.argumentsJson === 'string' ? ev.payload.argumentsJson : undefined}
              result={matchedResult?.result as never}
            />
          );
        }

        if (ev.type === 'tool_result') {
          // Already rendered inline under tool_call
          return null;
        }

        if (ev.type === 'system_notice') {
          const message =
            typeof ev.payload.message === 'string'
              ? ev.payload.message
              : ev.payload.kind === 'task_created'
                ? `已创建投递任务并锁定档案快照 · ${String(ev.payload.applyUrl ?? '')}`
                : JSON.stringify(ev.payload);
          return (
            <div
              key={ev.id}
              className="rounded-lg border border-slate-200 bg-slate-100/80 px-3 py-1.5 text-[11px] text-slate-600"
            >
              {message}
            </div>
          );
        }

        return null;
      })}

      {(streamingText || streamingReasoning) && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 text-xs">
          {streamingReasoning && (
            <div className="mb-1.5 whitespace-pre-wrap text-[11px] text-slate-500">
              {streamingReasoning}
            </div>
          )}
          <div className="whitespace-pre-wrap leading-relaxed text-slate-800">{streamingText}</div>
        </div>
      )}
    </div>
  );
}
