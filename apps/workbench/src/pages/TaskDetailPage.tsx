import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  Hand,
  Play,
  RefreshCw,
  Send,
  XCircle,
} from 'lucide-react';
import type {
  ClientMessageId,
  TaskDetailProjection,
  TaskId,
} from '@jobhelper/contracts';
import { BrowserSurfaceSlot } from '../components/BrowserSurfaceSlot.js';
import { EventTimeline } from '../components/EventTimeline.js';
import {
  QuestionCard,
  ResultCheckCard,
  SubmissionReviewCard,
  TodoActionCard,
} from '../components/HitlCards.js';
import { ControlModeBadge, FourAxisBadges } from '../components/StatusBadges.js';
import type { JobHelperBridge } from '../lib/bridge.js';

interface TaskDetailPageProps {
  bridge: JobHelperBridge;
  taskId: TaskId;
  streamingText?: string;
  streamingReasoning?: string;
  onBack: () => void;
  onRefreshTasks: () => Promise<void>;
}

export function TaskDetailPage({
  bridge,
  taskId,
  streamingText,
  streamingReasoning,
  onBack,
  onRefreshTasks,
}: TaskDetailPageProps) {
  const [projection, setProjection] = useState<TaskDetailProjection | null>(null);
  const [messageText, setMessageText] = useState('');
  const [navUrl, setNavUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadProjection = async () => {
    try {
      const next = await bridge['tasks:getProjection']({ taskId });
      setProjection(next);
      setNavUrl(next.tabs[0]?.url ?? next.task.applyUrl ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void loadProjection();
  }, [taskId]);

  useEffect(() => {
    if (!bridge.onMainEvent) return;
    return bridge.onMainEvent((ev) => {
      if (ev.type === 'tasks_changed' && (!ev.taskId || ev.taskId === taskId)) {
        void loadProjection();
      }
    });
  }, [bridge, taskId]);

  if (!projection) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        {error ? `加载失败：${error}` : '正在加载任务详情…'}
      </div>
    );
  }

  const { task, profileSnapshot, authorizedMaterials, tabs, openTodo, pendingQuestion, activeConfirmation, events } =
    projection;

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim()) return;
    const text = messageText.trim();
    setMessageText('');
    await bridge['tasks:sendMessage']({
      taskId,
      clientMessageId: crypto.randomUUID() as ClientMessageId,
      text,
    });
    await loadProjection();
    await onRefreshTasks();
  };

  const handleManualNav = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tabs[0] || !navUrl.trim()) return;
    setError(null);
    try {
      await bridge['browser:navigate']({
        taskId,
        tabId: tabs[0].id,
        url: navUrl.trim(),
      });
      await loadProjection();
      await onRefreshTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50">
      {/* Persistent Top Bar: Job info + 4-axis badges + Control owner + Takeover/Resume */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
            title="返回任务列表"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold text-slate-900">{task.title}</h1>
              {profileSnapshot && (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                  锁定档案 v{profileSnapshot.versionNumber}（{profileSnapshot.content.basic.fullName}）
                </span>
              )}
            </div>
            <div className="mt-1">
              <FourAxisBadges
                executionState={task.executionState}
                waitingReason={task.waitingReason}
                applicationStage={task.applicationStage}
                outcome={task.outcome}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ControlModeBadge mode={task.controlMode} />

          {task.executionState !== 'closed' && (
            <>
              <button
                type="button"
                onClick={() =>
                  void bridge['tasks:takeover']({ taskId })
                    .then(loadProjection)
                    .then(onRefreshTasks)
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
              >
                <Hand className="h-3.5 w-3.5" />
                我来操作
              </button>
              <button
                type="button"
                onClick={() =>
                  void bridge['tasks:resumeCheck']({ taskId })
                    .then(loadProjection)
                    .then(onRefreshTasks)
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
              >
                <Play className="h-3.5 w-3.5" />
                已处理，请检查
              </button>
              <button
                type="button"
                onClick={() => void bridge['browser:detachWindow']({ taskId }).then(loadProjection)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                title="先停止助手并将招聘网页拆出为独立窗口"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                拆出网页
              </button>
              <button
                type="button"
                onClick={() =>
                  void bridge['tasks:close']({ taskId })
                    .then(loadProjection)
                    .then(onRefreshTasks)
                }
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
              >
                <XCircle className="h-3.5 w-3.5" />
                关闭任务
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Split Pane: Left Chat/HITL + Right Real Recruitment Browser */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section className="flex w-[430px] shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {openTodo && (
              <TodoActionCard
                todo={openTodo}
                onResumeCheck={async () => {
                  await bridge['tasks:resumeCheck']({ taskId });
                  await loadProjection();
                  await onRefreshTasks();
                }}
              />
            )}

            {pendingQuestion && (
              <QuestionCard
                card={pendingQuestion}
                onSubmit={async (answers) => {
                  await bridge['tasks:answerQuestion']({
                    taskId,
                    questionCardId: pendingQuestion.id,
                    answers,
                  });
                  await loadProjection();
                  await onRefreshTasks();
                }}
              />
            )}

            {activeConfirmation && (
              <SubmissionReviewCard
                card={activeConfirmation}
                authorizedMaterials={authorizedMaterials}
                onConfirmManualSubmitted={async () => {
                  await bridge['tasks:resolveConfirmation']({
                    taskId,
                    confirmationId: activeConfirmation.id,
                    decision: 'manual_submitted',
                  });
                  await loadProjection();
                  await onRefreshTasks();
                }}
                onDeclineAndEdit={async () => {
                  await bridge['tasks:resolveConfirmation']({
                    taskId,
                    confirmationId: activeConfirmation.id,
                    decision: 'decline',
                  });
                  await loadProjection();
                  await onRefreshTasks();
                }}
              />
            )}

            {(task.applicationStage === 'verifying' ||
              task.waitingReason === 'result_check' ||
              task.outcome === 'unknown') && (
              <ResultCheckCard
                onRecheckPage={async () => {
                  await bridge['tasks:resumeCheck']({ taskId });
                  await loadProjection();
                  await onRefreshTasks();
                }}
              />
            )}

            <EventTimeline
              events={events}
              streamingText={streamingText}
              streamingReasoning={streamingReasoning}
            />
          </div>

          <form onSubmit={(e) => void handleSend(e)} className="border-t border-slate-200 p-3">
            {error && (
              <div className="mb-2 rounded border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] text-rose-700">
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                disabled={task.executionState === 'closed'}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder={
                  task.executionState === 'closed'
                    ? '任务已关闭（历史完整保留）'
                    : '补充岗位要求或对话指令…'
                }
                className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-indigo-500 focus:outline-none disabled:bg-slate-100"
              />
              <button
                type="submit"
                disabled={task.executionState === 'closed' || !messageText.trim()}
                className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                发送
              </button>
            </div>
          </form>
        </section>

        {/* Right Pane: URL Bar + Real WebContentsView Geometric Slot */}
        <section className="flex min-w-0 flex-1 flex-col">
          <form
            onSubmit={(e) => void handleManualNav(e)}
            className="flex items-center gap-2 border-b border-slate-200 bg-slate-100 px-3 py-2"
          >
            <input
              type="url"
              value={navUrl}
              onChange={(e) => setNavUrl(e.target.value)}
              className="flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-mono text-xs text-slate-700"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
              title="手动导航前会自动停止助手当前轮次"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              转到 / 刷新
            </button>
          </form>

          <BrowserSurfaceSlot
            bridge={bridge}
            taskId={taskId}
            activeUrl={tabs[0]?.url ?? task.applyUrl}
            controlMode={task.controlMode}
          />
        </section>
      </div>
    </div>
  );
}
