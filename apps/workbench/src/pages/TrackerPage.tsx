import React, { useEffect, useState } from 'react';
import { ExternalLink, Plus } from 'lucide-react';
import type { PositionProgressStage, PositionRecord, TaskId } from '@jobhelper/contracts';
import type { JobHelperBridge } from '../lib/bridge.js';

interface TrackerPageProps {
  bridge: JobHelperBridge;
  onRefreshTasks: () => Promise<void>;
  onOpenTask: (taskId: TaskId) => void;
}

const STAGE_OPTIONS: Array<{ value: PositionProgressStage; label: string }> = [
  { value: 'saved', label: '已收藏待投' },
  { value: 'in_progress', label: '填写中' },
  { value: 'submitted_verified', label: '已投递（官网回执确认）' },
  { value: 'submitted_user_reported', label: '已投递（用户手动报告）' },
  { value: 'assessment', label: '笔试 / 测评' },
  { value: 'interview', label: '面试中' },
  { value: 'offer', label: 'Offer' },
  { value: 'closed', label: '已结束' },
];

export function TrackerPage({ bridge, onRefreshTasks, onOpenTask }: TrackerPageProps) {
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [company, setCompany] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [applyUrl, setApplyUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setPositions(await bridge['positions:list']());
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await bridge['positions:add']({
        company: company.trim(),
        jobTitle: jobTitle.trim(),
        applyUrl: applyUrl.trim(),
      });
      setCompany('');
      setJobTitle('');
      setApplyUrl('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">本地求职进度</h1>
        <p className="text-xs text-slate-500">
          严格区分「官网回执确认」与「用户手动报告」，支持后续笔试、面试和 Offer 阶段维护
        </p>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-6">
        <form
          onSubmit={(e) => void handleAdd(e)}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs"
        >
          <div className="grid gap-2.5 sm:grid-cols-4 text-xs">
            <input
              type="text"
              required
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="公司名称"
              className="rounded-lg border border-slate-300 px-3 py-1.5"
            />
            <input
              type="text"
              required
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="岗位名称"
              className="rounded-lg border border-slate-300 px-3 py-1.5"
            />
            <input
              type="url"
              required
              value={applyUrl}
              onChange={(e) => setApplyUrl(e.target.value)}
              placeholder="官方投递网址 https://..."
              className="rounded-lg border border-slate-300 px-3 py-1.5"
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700"
            >
              <Plus className="h-3.5 w-3.5" />
              添加岗位记录
            </button>
          </div>
          {error && <div className="mt-2 text-xs text-rose-600">{error}</div>}
        </form>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">公司 / 岗位</th>
                <th className="px-4 py-2.5 font-medium">当前进度（含证据来源）</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-slate-400">
                    暂无岗位进度记录
                  </td>
                </tr>
              ) : (
                positions.map((pos) => (
                  <tr key={pos.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">
                        {pos.company} · {pos.jobTitle}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                        {pos.applyUrl}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={pos.progressStage}
                        onChange={(e) =>
                          void bridge['positions:updateProgress']({
                            positionId: pos.id,
                            stage: e.target.value as PositionProgressStage,
                          }).then(load)
                        }
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
                      >
                        {STAGE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await bridge['tasks:startApplication']({
                            applyUrl: pos.applyUrl,
                            positionId: pos.id,
                          });
                          await onRefreshTasks();
                          onOpenTask(res.taskId);
                        }}
                        className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
                      >
                        <ExternalLink className="h-3 w-3" />
                        开始网申
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
