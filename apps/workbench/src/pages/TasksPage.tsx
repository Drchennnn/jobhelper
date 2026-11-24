import React, { useState } from 'react';
import { ExternalLink, Hand, Play, Plus, X } from 'lucide-react';
import type { MaterialId, MaterialRecord, ProfileId, ProfileRecord, TaskId, TaskRecord } from '@jobhelper/contracts';
import { FourAxisBadges } from '../components/StatusBadges.js';
import type { JobHelperBridge } from '../lib/bridge.js';

type FilterTab = 'all' | 'queued' | 'running' | 'waiting_user' | 'closed';

interface TasksPageProps {
  bridge: JobHelperBridge;
  tasks: TaskRecord[];
  profiles: ProfileRecord[];
  defaultProfileId: ProfileId | null;
  materials: MaterialRecord[];
  onRefresh: () => Promise<void>;
  onOpenTask: (taskId: TaskId) => void;
}

export function TasksPage({
  bridge,
  tasks,
  profiles,
  defaultProfileId,
  materials,
  onRefresh,
  onOpenTask,
}: TasksPageProps) {
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [applyUrl, setApplyUrl] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState<string>(defaultProfileId ?? '');
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<MaterialId[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const appTasks = tasks.filter((t) => t.kind === 'application');
  const filtered = appTasks.filter((t) => {
    if (filter === 'all') return true;
    if (filter === 'waiting_user') {
      return ['waiting_user', 'paused', 'interrupted', 'error'].includes(t.executionState);
    }
    return t.executionState === filter;
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await bridge['tasks:startApplication']({
        applyUrl: applyUrl.trim(),
        profileId: (selectedProfileId || defaultProfileId || undefined) as ProfileId | undefined,
        materialIds: selectedMaterialIds.length > 0 ? selectedMaterialIds : undefined,
        note: note.trim() || undefined,
      });
      setShowCreateModal(false);
      setApplyUrl('');
      setNote('');
      await onRefresh();
      onOpenTask(res.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">投递任务</h1>
          <p className="text-xs text-slate-500">
            每个岗位任务独立锁定档案快照与浏览器标签页；同未完成岗位重复发起自动复用原任务
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setSelectedProfileId(defaultProfileId ?? profiles[0]?.id ?? '');
            setShowCreateModal(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          粘贴岗位 URL 新建任务
        </button>
      </header>

      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-6 py-2.5">
        {(
          [
            ['all', `全部 (${appTasks.length})`],
            ['queued', '排队中'],
            ['running', '执行中'],
            ['waiting_user', '待我处理'],
            ['closed', '已结束'],
          ] as Array<[FilterTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              filter === id
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400">
            当前筛选下暂无投递任务
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {filtered.map((task) => (
              <div
                key={task.id}
                className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-xs"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{task.title}</div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                        {task.applyUrl}
                      </div>
                    </div>
                    <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600">
                      快照 {task.profileVersionId?.slice(0, 8) ?? '未绑定'}
                    </span>
                  </div>
                  <div className="mt-3">
                    <FourAxisBadges
                      executionState={task.executionState}
                      waitingReason={task.waitingReason}
                      applicationStage={task.applicationStage}
                      outcome={task.outcome}
                    />
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                  {task.executionState === 'running' && (
                    <button
                      type="button"
                      onClick={() => void bridge['tasks:takeover']({ taskId: task.id }).then(onRefresh)}
                      className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                    >
                      <Hand className="h-3.5 w-3.5" />
                      我来操作
                    </button>
                  )}
                  {['paused', 'waiting_user', 'interrupted', 'error'].includes(task.executionState) && (
                    <button
                      type="button"
                      onClick={() => void bridge['tasks:resumeCheck']({ taskId: task.id }).then(onRefresh)}
                      className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                    >
                      <Play className="h-3.5 w-3.5" />
                      检查并继续
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenTask(task.id)}
                    className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    打开工作台
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <form
            onSubmit={(e) => void handleCreate(e)}
            className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-base font-semibold text-slate-900">新建网申投递任务（建前确认）</h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs">
              <div>
                <label className="font-medium text-slate-700">目标招聘岗位网址（HTTP/HTTPS）</label>
                <input
                  type="url"
                  required
                  value={applyUrl}
                  onChange={(e) => setApplyUrl(e.target.value)}
                  placeholder="https://app.mokahr.com/campus-recruitment/..."
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="font-medium text-slate-700">
                  本次锁定档案（创建后固定快照，切换全局默认简历不影响本任务）
                </label>
                <select
                  value={selectedProfileId}
                  onChange={(e) => setSelectedProfileId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.id === defaultProfileId ? '（全局默认）' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {materials.length > 0 && (
                <div>
                  <div className="font-medium text-slate-700">授权给本任务的附件材料</div>
                  <div className="mt-1 max-h-28 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                    {materials.map((m) => (
                      <label key={m.id} className="flex items-center gap-2 text-xs text-slate-700">
                        <input
                          type="checkbox"
                          checked={selectedMaterialIds.includes(m.id)}
                          onChange={(e) =>
                            setSelectedMaterialIds((prev) =>
                              e.target.checked ? [...prev, m.id] : prev.filter((id) => id !== m.id),
                            )
                          }
                        />
                        <span>{m.fileName}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="font-medium text-slate-700">补充说明（可选）</label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="例如：第一志愿选择上海研发中心"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
              </div>

              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  {error}
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700"
              >
                确认绑定并创建任务
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
