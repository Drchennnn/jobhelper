import React from 'react';
import type {
  ApplicationOutcome,
  ApplicationStage,
  BrowserControlMode,
  ExecutionState,
  WaitingReason,
} from '@jobhelper/contracts';

const EXECUTION_LABELS: Record<ExecutionState, { text: string; cls: string }> = {
  draft: { text: '草稿', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  queued: { text: '排队中', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  running: { text: '执行中', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  stopping: { text: '停止中…', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  paused: { text: '人工接管', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  waiting_user: { text: '待我处理', cls: 'bg-orange-50 text-orange-800 border-orange-200' },
  interrupted: { text: '已中断待检查', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  error: { text: '异常待处理', cls: 'bg-red-50 text-red-700 border-red-200' },
  closed: { text: '已结束', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
};

const WAITING_LABELS: Record<WaitingReason, string> = {
  none: '',
  login: '需登录招聘站',
  captcha: '需处理验证码',
  missing_info: '需补充事实信息',
  manual_control: '由你手动操作网页',
  submission_confirmation: '待核对填写内容',
  manual_submit: '待你在官网点击提交',
  result_check: '待核验提交回执',
};

const STAGE_LABELS: Record<ApplicationStage, string> = {
  created: '已建任务',
  opened: '已开网页',
  inspecting: '观察字段中',
  filling: '填表中',
  filling_ready: '主要内容已填好',
  submit_attempted: '已触发提交',
  verifying: '回执核验中',
  done: '流程收束',
};

const OUTCOME_LABELS: Record<ApplicationOutcome, { text: string; cls: string }> = {
  not_submitted: { text: '未提交', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  unknown: { text: '结果待核验', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  submitted_verified: { text: '官网已确认投递', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  user_reported: { text: '已手动提交（用户报告）', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
  job_unavailable: { text: '岗位不可投递', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  closed_without_submit: { text: '未提交已关闭', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};

export function FourAxisBadges(props: {
  executionState: ExecutionState;
  waitingReason: WaitingReason;
  applicationStage: ApplicationStage;
  outcome: ApplicationOutcome;
}) {
  const exec = EXECUTION_LABELS[props.executionState];
  const wait = WAITING_LABELS[props.waitingReason];
  const out = OUTCOME_LABELS[props.outcome];

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 font-medium ${exec.cls}`}>
        {exec.text}
      </span>
      {wait && (
        <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 font-medium text-orange-800">
          {wait}
        </span>
      )}
      <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
        阶段：{STAGE_LABELS[props.applicationStage]}
      </span>
      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 font-medium ${out.cls}`}>
        {out.text}
      </span>
    </div>
  );
}

export function ControlModeBadge({ mode }: { mode: BrowserControlMode }) {
  if (mode === 'agent') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
        <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-600" />
        当前控制者：助手操作中
      </span>
    );
  }
  if (mode === 'stopping') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        当前控制者：停止收束中…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      当前控制者：由你操作
    </span>
  );
}
