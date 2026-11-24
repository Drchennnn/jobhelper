import React from 'react';
import {
  Bot,
  Briefcase,
  ClipboardList,
  FileUser,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import type { WorkbenchRouteId } from '../routes.js';

interface LayoutProps {
  activeRoute: WorkbenchRouteId;
  waitingUserCount: number;
  isElectron: boolean;
  onNavigate: (route: WorkbenchRouteId) => void;
  children: React.ReactNode;
}

const NAV_ITEMS: Array<{
  id: Exclude<WorkbenchRouteId, 'task-detail'>;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'assistant', label: '助手', icon: Bot },
  { id: 'tasks', label: '投递任务', icon: ClipboardList },
  { id: 'profiles', label: '档案与材料', icon: FileUser },
  { id: 'tracker', label: '求职进度', icon: Briefcase },
  { id: 'settings', label: '设置与技能', icon: Settings },
];

export function Layout({
  activeRoute,
  waitingUserCount,
  isElectron,
  onNavigate,
  children,
}: LayoutProps) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-slate-900">JobHelper</div>
            <div className="text-[11px] text-slate-500">本地 BYOK 网申助手</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive =
              activeRoute === item.id ||
              (activeRoute === 'task-detail' && item.id === 'tasks');
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4" />
                  {item.label}
                </span>
                {item.id === 'tasks' && waitingUserCount > 0 && (
                  <span className="rounded-full bg-orange-500 px-2 py-0.5 text-[11px] font-semibold text-white">
                    {waitingUserCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-3 text-[11px] text-slate-500">
          <div className="flex items-center justify-between">
            <span>运行模式</span>
            <span className="font-medium text-slate-700">
              {isElectron ? 'Electron 本机' : '浏览器预览'}
            </span>
          </div>
          <div className="mt-1 text-[10px] text-slate-400">
            最终提交默认由你在真实网页亲自确认
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
