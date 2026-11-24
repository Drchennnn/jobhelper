import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Hand,
  HelpCircle,
  RefreshCw,
} from 'lucide-react';
import type {
  ConfirmationCardRecord,
  MaterialRecord,
  QuestionCardRecord,
  QuestionId,
  TodoCardRecord,
} from '@jobhelper/contracts';

export function TodoActionCard({
  todo,
  onResumeCheck,
}: {
  todo: TodoCardRecord;
  onResumeCheck: () => Promise<void>;
}) {
  const isBrowserAction =
    todo.reason === 'login' ||
    todo.reason === 'captcha' ||
    todo.reason === 'manual_control' ||
    todo.reason === 'manual_submit';

  return (
    <div className="rounded-xl border border-orange-200 bg-orange-50/80 p-3.5 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-orange-900">
          <Hand className="h-4 w-4 text-orange-600" />
          <span>{todo.summary}</span>
        </div>
        <span className="rounded bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-800">
          {isBrowserAction ? '去右侧网页操作' : '在左栏处理'}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-orange-900/80">{todo.instructions}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[11px] text-orange-700/80">
          点击「已处理，请检查」将让助手重新观察页面，不会直接认定登录或提交成功。
        </span>
        <button
          type="button"
          onClick={() => void onResumeCheck()}
          className="shrink-0 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700"
        >
          已处理，请检查
        </button>
      </div>
    </div>
  );
}

export function QuestionCard({
  card,
  onSubmit,
}: {
  card: QuestionCardRecord;
  onSubmit: (
    answers: Array<{ questionId: QuestionId; value: string; saveToProfile: boolean }>,
  ) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveFlags, setSaveFlags] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(card.questions.map((q) => [q.id, q.saveToProfileDefault])),
  );
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(
        card.questions.map((q) => ({
          questionId: q.id,
          value: (values[q.id] ?? '').trim(),
          saveToProfile: Boolean(saveFlags[q.id]),
        })),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3.5 shadow-xs"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-indigo-950">
          <HelpCircle className="h-4 w-4 text-indigo-600" />
          <span>需要补充真实事实（在左栏回答）</span>
        </div>
        {card.status === 'expired_pending' && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            超时待补答（将回挂原问题）
          </span>
        )}
      </div>

      <div className="mt-3 space-y-3">
        {card.questions.map((q) => (
          <div key={q.id} className="rounded-lg border border-indigo-100 bg-white p-2.5">
            <div className="text-xs font-medium text-slate-800">{q.prompt}</div>
            {q.options && q.options.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {q.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setValues((prev) => ({ ...prev, [q.id]: opt }))}
                    className={`rounded-md border px-2.5 py-1 text-xs transition ${
                      values[q.id] === opt
                        ? 'border-indigo-600 bg-indigo-600 text-white'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
            {q.allowFreeText && (
              <input
                type="text"
                value={values[q.id] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [q.id]: e.target.value }))}
                placeholder="输入真实信息…"
                className="mt-2 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
              />
            )}
            <label className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-600">
              <input
                type="checkbox"
                checked={Boolean(saveFlags[q.id])}
                onChange={(e) => setSaveFlags((prev) => ({ ...prev, [q.id]: e.target.checked }))}
                className="rounded border-slate-300"
              />
              同时保存到个人事实库（供后续岗位复用）
            </label>
          </div>
        ))}
      </div>

      <div className="mt-3 flex justify-end">
        <button
          type="submit"
          disabled={submitting || card.questions.some((q) => !(values[q.id] ?? '').trim())}
          className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {submitting ? '提交回答中…' : '提交回答并继续'}
        </button>
      </div>
    </form>
  );
}

export function SubmissionReviewCard({
  card,
  authorizedMaterials,
  onConfirmManualSubmitted,
  onDeclineAndEdit,
}: {
  card: ConfirmationCardRecord;
  authorizedMaterials: MaterialRecord[];
  onConfirmManualSubmitted: () => Promise<void>;
  onDeclineAndEdit: () => Promise<void>;
}) {
  const [confirmStep, setConfirmStep] = useState(false);

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-950">
          <FileCheck2 className="h-4 w-4 text-emerald-600" />
          <span>填写核对卡（首版由你在右侧网页最终提交）</span>
        </div>
        <span className="rounded bg-emerald-100 px-2 py-0.5 font-mono text-[10px] text-emerald-800">
          #{card.contentHash.slice(0, 8)}
        </span>
      </div>

      <div className="mt-2.5 rounded-lg border border-emerald-100 bg-white p-3 text-xs">
        <div className="font-semibold text-slate-900">
          {card.summary.company ?? '目标公司'} · {card.summary.jobTitle ?? '目标岗位'}
        </div>

        {card.summary.keyFields.length > 0 && (
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-slate-100 pt-2">
            {card.summary.keyFields.map((f, idx) => (
              <div key={idx}>
                <dt className="text-[11px] text-slate-400">{f.label}</dt>
                <dd className="font-medium text-slate-800">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {card.summary.missingItems.length > 0 && (
          <div className="mt-2.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
            <div className="font-semibold">待人工补充/核对项：</div>
            <ul className="mt-1 list-disc pl-4">
              {card.summary.missingItems.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          <span>授权附件：{authorizedMaterials.map((m) => m.fileName).join('、') || '无'}</span>
          <span>·</span>
          <span>核对截图：{card.summary.screenshotArtifactIds.length} 张</span>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-emerald-900/80">
        请在右侧真实招聘网页逐项核对，确认无误后亲自点击官网提交按钮。若你在网页修改了内容，此核对卡将自动失效并需重新核对。
      </p>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => void onDeclineAndEdit()}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          暂不提交，返回修改
        </button>

        {!confirmStep ? (
          <button
            type="button"
            onClick={() => setConfirmStep(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            我已在官网手动提交
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onConfirmManualSubmitted()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
          >
            再次确认：官网已提交完成（记为用户报告）
          </button>
        )}
      </div>
    </div>
  );
}

export function ResultCheckCard({
  onRecheckPage,
}: {
  onRecheckPage: () => Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 shadow-xs">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <span>投递结果待核验（严禁自动重复提交）</span>
      </div>
      <p className="mt-1.5 text-xs text-amber-900/80">
        系统检测到提交动作已发生或上次执行中断，但尚未确认招聘官网的成功回执。点击下方按钮仅进行只读页面核验，不会再次点击提交。
      </p>
      <div className="mt-2.5 flex justify-end">
        <button
          type="button"
          onClick={() => void onRecheckPage()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          只读检查官网回执
        </button>
      </div>
    </div>
  );
}
