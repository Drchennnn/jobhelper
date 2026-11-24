import React, { useEffect, useState } from 'react';
import { ArrowRight, PlusCircle, Send } from 'lucide-react';
import type {
  ClientMessageId,
  ProfileId,
  ProfileRecord,
  TaskEventRecord,
  TaskId,
  TaskRecord,
} from '@jobhelper/contracts';
import { EventTimeline } from '../components/EventTimeline.js';
import { FourAxisBadges } from '../components/StatusBadges.js';
import type { JobHelperBridge } from '../lib/bridge.js';

interface AssistantPageProps {
  bridge: JobHelperBridge;
  tasks: TaskRecord[];
  profiles: ProfileRecord[];
  defaultProfileId: ProfileId | null;
  onRefresh: () => Promise<void>;
  onOpenTask: (taskId: TaskId) => void;
}

export function AssistantPage({
  bridge,
  tasks,
  profiles,
  defaultProfileId,
  onRefresh,
  onOpenTask,
}: AssistantPageProps) {
  const [coordinator, setCoordinator] = useState<TaskRecord | null>(null);
  const [events, setEvents] = useState<TaskEventRecord[]>([]);
  const [inputText, setInputText] = useState('');
  const [quickUrl, setQuickUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadCoordinator = async () => {
    const coord = await bridge['tasks:getCoordinator']();
    setCoordinator(coord);
    const evs = await bridge['tasks:events']({ taskId: coord.id, afterSeq: 0 });
    setEvents(evs);
  };

  useEffect(() => {
    void loadCoordinator();
  }, [tasks.length]);

  const delegatedTasks = tasks.filter((t) => t.kind === 'application');

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!coordinator || !inputText.trim()) return;
    setError(null);
    const text = inputText.trim();
    setInputText('');
    await bridge['tasks:sendMessage']({
      taskId: coordinator.id,
      clientMessageId: crypto.randomUUID() as ClientMessageId,
      text,
    });
    await loadCoordinator();
    await onRefresh();
  };

  const handleQuickDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickUrl.trim()) return;
    setError(null);
    try {
      const res = await bridge['tasks:startApplication']({
        applyUrl: quickUrl.trim(),
        profileId: defaultProfileId ?? undefined,
        originConversationId: coordinator?.id,
      });
      setQuickUrl('');
      await onRefresh();
      onOpenTask(res.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const activeProfileName =
    profiles.find((p) => p.id === defaultProfileId)?.name ?? '尚未选择默认档案';

  return (
    <div className="flex h-full overflow-hidden">
      <section className="flex flex-1 flex-col border-r border-slate-200 bg-white">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div>
            <h1 className="text-base font-semibold text-slate-900">求职总助手</h1>
            <p className="text-xs text-slate-500">
              负责整理档案、讨论岗位与派发独立投递任务；不直接操作招聘网页
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700">
            当前默认档案：<span className="font-semibold text-slate-900">{activeProfileName}</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <EventTimeline events={events} />
        </div>

        <form onSubmit={(e) => void handleSend(e)} className="border-t border-slate-200 p-4">
          {error && (
            <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs text-rose-700">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="告诉总助手你的求职需求，或贴入岗位说明让助手整理与派工…"
              className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <Send className="h-4 w-4" />
              发送
            </button>
          </div>
        </form>
      </section>

      <aside className="flex w-96 shrink-0 flex-col bg-slate-50 p-4">
        <form
          onSubmit={(e) => void handleQuickDispatch(e)}
          className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs"
        >
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
            <PlusCircle className="h-4 w-4 text-indigo-600" />
            直接粘贴岗位链接派发任务
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            将锁定当前默认档案版本快照，并打开独立投递任务与专属网页标签。
          </p>
          <input
            type="url"
            value={quickUrl}
            onChange={(e) => setQuickUrl(e.target.value)}
            placeholder="https://campus.zhiye.com/..."
            className="mt-2.5 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
          />
          <button
            type="submit"
            className="mt-2 w-full rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            创建独立投递任务
          </button>
        </form>

        <div className="mt-4 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            已派出的投递任务（{delegatedTasks.length}）
          </h2>
        </div>

        <div className="mt-2.5 flex-1 space-y-2.5 overflow-y-auto">
          {delegatedTasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-center text-xs text-slate-400">
              尚未派出任何岗位投递任务
            </div>
          ) : (
            delegatedTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => onOpenTask(task.id)}
                className="block w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-indigo-300 hover:shadow-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-sm font-semibold text-slate-900">{task.title}</div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-slate-400">
                  {task.applyUrl}
                </div>
                <div className="mt-2">
                  <FourAxisBadges
                    executionState={task.executionState}
                    waitingReason={task.waitingReason}
                    applicationStage={task.applicationStage}
                    outcome={task.outcome}
                  />
                </div>
              </button>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
