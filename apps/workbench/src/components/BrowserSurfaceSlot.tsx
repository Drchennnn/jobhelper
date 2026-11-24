import React, { useEffect, useRef } from 'react';
import { Globe, Lock } from 'lucide-react';
import type { BrowserControlMode, TaskId } from '@jobhelper/contracts';
import type { JobHelperBridge } from '../lib/bridge.js';

interface BrowserSurfaceSlotProps {
  bridge: JobHelperBridge;
  taskId: TaskId;
  activeUrl?: string;
  controlMode: BrowserControlMode;
  /** When true (e.g. a modal dialog is open), temporarily hides the native WebContentsView so it cannot cover UI overlays. */
  overlayActive?: boolean;
}

export function BrowserSurfaceSlot({
  bridge,
  taskId,
  activeUrl,
  controlMode,
  overlayActive = false,
}: BrowserSurfaceSlotProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;

    const sync = () => {
      const rect = el.getBoundingClientRect();
      const shouldShow = !overlayActive && rect.width > 10 && rect.height > 10;
      void bridge['browser:syncSurface']({
        taskId,
        visible: shouldShow,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      void bridge['browser:syncSurface']({
        taskId: null,
        visible: false,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      });
    };
  }, [bridge, taskId, overlayActive]);

  return (
    <div
      ref={slotRef}
      data-testid="browser-surface-slot"
      className="relative flex flex-1 flex-col items-center justify-center bg-slate-100 text-center"
    >
      {!bridge.isElectron ? (
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <Globe className="h-6 w-6" />
          </div>
          <div className="text-sm font-semibold text-slate-900">真实本机招聘网页视口（WebContentsView）</div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
            在 Electron 桌面端运行时，此区域由主进程同步渲染任务所属的原生招聘网页标签；助手操作期间仅本任务受控，点击「我来操作」立即由你直接操作网页。
          </p>
          {activeUrl && (
            <div className="mt-3 flex items-center justify-center gap-1.5 rounded-lg bg-slate-50 px-3 py-1.5 font-mono text-[11px] text-slate-600">
              <Lock className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span className="truncate">{activeUrl}</span>
            </div>
          )}
          <div className="mt-3 text-[11px] text-slate-400">
            控制权状态：{controlMode === 'agent' ? '助手受控执行' : controlMode === 'stopping' ? '正在停止' : '用户可交互'}
          </div>
        </div>
      ) : (
        overlayActive && (
          <div className="text-xs text-slate-400">弹窗打开中，已临时隐藏原生网页视图以避免遮挡</div>
        )
      )}
    </div>
  );
}
