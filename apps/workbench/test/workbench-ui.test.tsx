import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  CallId,
  ConfirmationId,
  ContentHash,
  EventId,
  IsoTimestamp,
  QuestionId,
  RunId,
  TaskId,
  TodoId,
} from '@jobhelper/contracts';
import { App } from '../src/App.js';
import { EventTimeline } from '../src/components/EventTimeline.js';
import {
  QuestionCard,
  ResultCheckCard,
  SubmissionReviewCard,
  TodoActionCard,
} from '../src/components/HitlCards.js';
import { ControlModeBadge, FourAxisBadges } from '../src/components/StatusBadges.js';
import { createBrowserPreviewBridge } from '../src/lib/bridge.js';

const NOW = '2026-11-24T12:00:00.000Z' as IsoTimestamp;

describe('@jobhelper/workbench M4 React UI Rendering & HITL Card Contracts', () => {
  it('renders unified single-sidebar workbench shell without legacy remote-desktop terminology', () => {
    const html = renderToStaticMarkup(React.createElement(App, { bridge: createBrowserPreviewBridge() }));
    expect(html).toContain('JobHelper');
    expect(html).toContain('助手');
    expect(html).toContain('投递任务');
    expect(html).toContain('档案与材料');
    expect(html).toContain('求职进度');
    expect(html).toContain('设置与技能');
    expect(html).not.toContain('远程桌面');
  });

  it('renders distinct 4-axis badges and persistent control owner indicator', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        'div',
        null,
        React.createElement(FourAxisBadges, {
          executionState: 'waiting_user',
          waitingReason: 'submission_confirmation',
          applicationStage: 'filling_ready',
          outcome: 'not_submitted',
        }),
        React.createElement(ControlModeBadge, { mode: 'agent' }),
        React.createElement(ControlModeBadge, { mode: 'stopping' }),
        React.createElement(ControlModeBadge, { mode: 'human' }),
      ),
    );

    expect(html).toContain('待我处理');
    expect(html).toContain('待核对填写内容');
    expect(html).toContain('主要内容已填好');
    expect(html).toContain('未提交');
    expect(html).toContain('助手操作中');
    expect(html).toContain('停止收束中');
    expect(html).toContain('由你操作');
  });

  it('renders structured Todo, Question, SubmissionReview, ResultCheck cards and EventTimeline', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        'div',
        null,
        React.createElement(TodoActionCard, {
          todo: {
            id: 'todo-1' as TodoId,
            taskId: 't-1' as TaskId,
            reason: 'login',
            summary: '请扫码登录北森系统',
            instructions: '在右侧招聘网页完成微信扫码登录',
            status: 'open',
            createdAt: NOW,
          },
          onResumeCheck: async () => {},
        }),
        React.createElement(QuestionCard, {
          card: {
            id: 'qcard-1',
            taskId: 't-1' as TaskId,
            runId: 'run-1' as RunId,
            callId: 'call-1' as CallId,
            status: 'expired_pending',
            questions: [
              {
                id: 'q-1' as QuestionId,
                prompt: '本科 GPA 是多少？',
                allowFreeText: true,
                saveToProfileDefault: true,
              },
            ],
            createdAt: NOW,
          },
          onSubmit: async () => {},
        }),
        React.createElement(SubmissionReviewCard, {
          card: {
            id: 'conf-1' as ConfirmationId,
            taskId: 't-1' as TaskId,
            runId: 'run-1' as RunId,
            operation: 'final_submit',
            status: 'pending',
            contentHash: 'abcdef1234567890' as ContentHash,
            summary: {
              company: 'MockCorp',
              jobTitle: 'Frontend Engineer',
              keyFields: [{ label: '姓名', value: '林星河' }],
              missingItems: ['期望薪资'],
              attachmentIds: [],
              screenshotArtifactIds: [],
            },
            createdAt: NOW,
          },
          authorizedMaterials: [],
          onConfirmManualSubmitted: async () => {},
          onDeclineAndEdit: async () => {},
        }),
        React.createElement(ResultCheckCard, { onRecheckPage: async () => {} }),
        React.createElement(EventTimeline, {
          events: [
            {
              id: 'e-1' as EventId,
              taskId: 't-1' as TaskId,
              seq: 1,
              type: 'user_message',
              payload: { text: '开始填写' },
              createdAt: NOW,
            },
            {
              id: 'e-2' as EventId,
              taskId: 't-1' as TaskId,
              seq: 2,
              type: 'tool_call',
              payload: { callId: 'c1', toolName: 'observe', argumentsJson: '{}' },
              createdAt: NOW,
            },
            {
              id: 'e-3' as EventId,
              taskId: 't-1' as TaskId,
              seq: 3,
              type: 'tool_result',
              payload: { callId: 'c1', toolName: 'observe', result: { ok: true } },
              createdAt: NOW,
            },
          ],
        }),
      ),
    );

    expect(html).toContain('去右侧网页操作');
    expect(html).toContain('超时待补答');
    expect(html).toContain('本科 GPA 是多少？');
    expect(html).toContain('同时保存到个人事实库');
    expect(html).toContain('填写核对卡');
    expect(html).toContain('#abcdef12');
    expect(html).toContain('我已在官网手动提交');
    expect(html).toContain('严禁自动重复提交');
    expect(html).toContain('observe');
  });
});
