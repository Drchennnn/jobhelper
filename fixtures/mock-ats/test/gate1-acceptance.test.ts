import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type {
  CallId,
  ContentHash,
  Epoch,
  IsoTimestamp,
  MainToWorkerMessage,
  ProfileContent,
  QuestionId,
  RunId,
  TaskId,
  ViewportRect,
  WorkerToMainMessage,
} from '@jobhelper/contracts';
import type {
  ManagedDebugger,
  ManagedWebContentsView,
  WebContentsViewFactory,
} from '@jobhelper/browser-bridge';
import { InMemoryCredentialStore } from '@jobhelper/model-router';
import {
  createDesktopMainKernel,
  registerDesktopIpcHandlers,
  runTaskTurnInKernel,
  type DesktopMainKernel,
  type WorkerChildTransport,
} from '../../../apps/desktop/src/main/index.js';
import { createJobHelperPreloadApi } from '../../../apps/desktop/src/preload/index.js';
import { SharedAgentWorkerHost } from '../../../apps/desktop/src/worker/index.js';
import { startMockAtsServer, type MockAtsServerHandle } from '../server.js';

const FICTIONAL_PROFILE_A: ProfileContent = {
  basic: {
    fullName: '林星河',
    phone: '13800138000',
    email: 'lin@example.com',
    city: '上海',
  },
  education: [
    {
      school: '复旦大学',
      degree: '硕士',
      major: '计算机技术',
      startDate: '2024-09',
      endDate: '2027-06',
    },
  ],
  internships: [],
  projects: [],
  skills: ['TypeScript', 'React', 'Electron'],
};

const FICTIONAL_PROFILE_B: ProfileContent = {
  ...FICTIONAL_PROFILE_A,
  basic: { ...FICTIONAL_PROFILE_A.basic, fullName: '周新宇', city: '北京' },
};

/**
 * Interactive DOM-backed FakeWebContentsView connected to the live MockAtsServer HTTP state.
 * Mirrors real login -> form -> manual human edit -> PDF upload -> manual submit -> receipt pages.
 */
class LiveMockAtsView implements ManagedWebContentsView {
  private bounds: ViewportRect;
  private visible = false;
  private destroyed = false;
  private url = '';
  private title = 'MockCorp';
  private attached = false;
  private readonly emitter = new EventEmitter();
  private readonly dbgEmitter = new EventEmitter();
  private focusedNodeId = '';

  public formValues = new Map<string, string>([
    ['node-fullName', ''],
    ['node-phone', ''],
    ['node-email', ''],
    ['node-city', ''],
    ['node-relocate', ''],
  ]);
  public uploadedFileName = '';
  public receiptHtml = '';
  public submittedClicks = 0;

  readonly webContents: ManagedWebContentsView['webContents'];

  constructor(
    public readonly targetId: string,
    private readonly mockAts: MockAtsServerHandle,
    initialBounds: ViewportRect,
  ) {
    this.bounds = { ...initialBounds };
    const dbg: ManagedDebugger = {
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true;
      },
      detach: () => {
        this.attached = false;
        this.dbgEmitter.emit('detach');
      },
      sendCommand: async (method, params = {}) => this.handleCdp(method, params),
      on: (e, fn) => {
        this.dbgEmitter.on(e, fn);
      },
      removeListener: (e, fn) => {
        this.dbgEmitter.removeListener(e, fn);
      },
    };

    this.webContents = {
      isDestroyed: () => this.destroyed,
      getURL: () => this.url,
      getTitle: () => this.title,
      getUserAgent: () => 'JobHelperGate1/1.0',
      getZoomFactor: () => 1,
      loadURL: async (nextUrl) => {
        this.emitter.emit('did-start-navigation');
        const res = await fetch(nextUrl, { redirect: 'follow' });
        this.url = res.url;
        const html = await res.text();
        const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
        this.title = titleMatch?.[1] ?? 'MockCorp';
        if (this.url.includes('/receipt/')) {
          this.receiptHtml = html;
        }
        this.emitter.emit('did-navigate');
        this.emitter.emit('did-stop-loading');
      },
      executeJavaScript: async () => undefined as never,
      capturePagePngBase64: async () => ({ base64: 'iVBORw0KGgo=', width: 1280, height: 800 }),
      debugger: dbg,
      on: (e, fn) => {
        this.emitter.on(e, fn);
      },
      removeListener: (e, fn) => {
        this.emitter.removeListener(e, fn);
      },
    };
  }

  private get isLoginPage(): boolean {
    return this.url.includes('/login');
  }

  private get isReceiptPage(): boolean {
    return this.url.includes('/receipt/');
  }

  private async handleCdp(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === 'Target.getTargetInfo') {
      return { targetInfo: { targetId: this.targetId } };
    }
    if (method === 'Accessibility.getFullAXTree') {
      if (this.isLoginPage) {
        return {
          nodes: [
            { backendDOMNodeId: 11, role: { value: 'textbox' }, name: { value: '手机号 / 邮箱' }, value: { value: '' } },
            {
              backendDOMNodeId: 12,
              role: { value: 'textbox' },
              name: { value: '登录密码' },
              value: { value: 'hidden-pw' },
              properties: [{ name: 'protected', value: { value: true } }],
            },
            { backendDOMNodeId: 13, role: { value: 'textbox' }, name: { value: '图形验证码' }, value: { value: '' } },
            { backendDOMNodeId: 14, role: { value: 'button' }, name: { value: '登录进入网申' } },
          ],
        };
      }
      if (this.isReceiptPage) {
        const text = this.receiptHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return {
          nodes: [{ backendDOMNodeId: 90, role: { value: 'staticText' }, name: { value: text } }],
        };
      }
      return {
        nodes: [
          { backendDOMNodeId: 21, role: { value: 'textbox' }, name: { value: '姓名' }, value: { value: this.formValues.get('node-fullName') ?? '' } },
          { backendDOMNodeId: 22, role: { value: 'textbox' }, name: { value: '手机号' }, value: { value: this.formValues.get('node-phone') ?? '' } },
          { backendDOMNodeId: 23, role: { value: 'textbox' }, name: { value: '邮箱' }, value: { value: this.formValues.get('node-email') ?? '' } },
          { backendDOMNodeId: 24, role: { value: 'combobox' }, name: { value: '期望工作城市' }, value: { value: this.formValues.get('node-city') ?? '' } },
          { backendDOMNodeId: 25, role: { value: 'textbox' }, name: { value: '是否接受短期出差' }, value: { value: this.formValues.get('node-relocate') ?? '' } },
          { backendDOMNodeId: 26, role: { value: 'button' }, name: { value: '附件简历' }, value: { value: this.uploadedFileName } },
          { backendDOMNodeId: 27, role: { value: 'button' }, name: { value: '保存草稿' } },
          { backendDOMNodeId: 28, role: { value: 'button' }, name: { value: '提交申请' } },
        ],
      };
    }

    if (method === 'DOM.resolveNode') {
      const id = Number(params.backendNodeId);
      const map: Record<number, string> = {
        11: 'node-account',
        12: 'node-password',
        13: 'node-captcha',
        14: 'node-login-btn',
        21: 'node-fullName',
        22: 'node-phone',
        23: 'node-email',
        24: 'node-city',
        25: 'node-relocate',
        26: 'node-resumeFile',
        27: 'node-saveDraft',
        28: 'node-submit',
      };
      return { object: { objectId: map[id] } };
    }

    if (method === 'DOM.setFileInputFiles') {
      const files = (params.files as string[]) ?? [];
      this.uploadedFileName = files[0] ? path.basename(files[0]) : '';
      return {};
    }

    if (method === 'Runtime.callFunctionOn') {
      const objId = String(params.objectId);
      const fn = String(params.functionDeclaration);
      const arg0 = (params.arguments as Array<{ value?: unknown }> | undefined)?.[0]?.value;

      if (fn.includes('accessibleLabel')) {
        if (objId === 'node-password') {
          return { result: { value: { tagName: 'INPUT', inputType: 'password', accessibleLabel: '登录密码', fieldIdentityText: 'password', inForm: true } } };
        }
        if (objId === 'node-captcha') {
          return { result: { value: { tagName: 'INPUT', inputType: 'text', accessibleLabel: '图形验证码', fieldIdentityText: 'captcha', inForm: true } } };
        }
        if (objId === 'node-submit') {
          return { result: { value: { tagName: 'BUTTON', buttonType: 'submit', accessibleLabel: '提交申请', inForm: true } } };
        }
        if (objId === 'node-city') {
          return { result: { value: { tagName: 'SELECT', accessibleLabel: '期望工作城市', inForm: true } } };
        }
        if (objId === 'node-resumeFile') {
          return { result: { value: { tagName: 'INPUT', inputType: 'file', accessibleLabel: '附件简历', inForm: true } } };
        }
        return { result: { value: { tagName: 'INPUT', inputType: 'text', accessibleLabel: objId, fieldIdentityText: objId, inForm: true } } };
      }

      if (fn.includes('this.focus()')) {
        this.focusedNodeId = objId;
        return { result: { value: true } };
      }
      if (fn.includes('this.files')) {
        return { result: { value: this.uploadedFileName } };
      }
      if (fn.includes("tagName !== 'SELECT'")) {
        const nextVal = String(arg0 ?? '');
        this.formValues.set(objId, nextVal);
        return { result: { value: nextVal } };
      }
      if (fn.includes('return this.value')) {
        return { result: { value: this.formValues.get(objId) ?? '' } };
      }
      if (fn.includes('getBoundingClientRect')) {
        return { result: { value: { x: 100, y: 100 } } };
      }
      return { result: { value: undefined } };
    }

    if (method === 'Input.insertText') {
      this.formValues.set(this.focusedNodeId, String(params.text ?? ''));
      return {};
    }
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mouseReleased') this.submittedClicks++;
      return {};
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('elementFromPoint(300, 400)')) {
        return {
          result: {
            value: { tagName: 'BUTTON', buttonType: 'submit', accessibleLabel: '提交申请', inForm: true },
          },
        };
      }
      if (expr.includes('document.activeElement')) {
        return { result: { value: { tagName: 'INPUT', inForm: true } } };
      }
      return { result: { value: {} } };
    }
    return {};
  }

  /** Simulates the human manually submitting the right-pane webpage form. */
  async simulateHumanManualSubmit(jobId = 'job-001'): Promise<{ status: number; receiptId?: string }> {
    const res = await fetch(`${this.mockAts.baseUrl}/api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        fullName: this.formValues.get('node-fullName') ?? '',
        phone: this.formValues.get('node-phone') ?? '',
        email: this.formValues.get('node-email') ?? '',
        city: this.formValues.get('node-city') ?? '',
        relocate: this.formValues.get('node-relocate') ?? '',
        uploadedFileName: this.uploadedFileName,
      }),
    });
    if (!res.ok) {
      return { status: res.status };
    }
    const data = (await res.json()) as { receiptId: string };
    await this.webContents.loadURL(`${this.mockAts.baseUrl}/receipt/${encodeURIComponent(data.receiptId)}`);
    return { status: res.status, receiptId: data.receiptId };
  }

  setBounds(b: ViewportRect): void {
    this.bounds = { ...b };
  }
  getBounds(): ViewportRect {
    return { ...this.bounds };
  }
  setVisible(v: boolean): void {
    this.visible = v;
  }
  getVisible(): boolean {
    return this.visible;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

describe('Gate 1 Acceptance Suite (G1-01..G1-08 Golden Path + G1-S01..G1-S10 Safety & Fault Boundaries)', () => {
  let mockAts: MockAtsServerHandle;
  let byokServer: http.Server;
  let byokBaseUrl: string;
  let byokFaultMode: 'ok' | 'rate_limit_429' = 'ok';

  beforeAll(async () => {
    mockAts = await startMockAtsServer({ requireLogin: true });

    // Local OpenAI-compatible BYOK mock server that also verifies stream_options fallback & capability probe
    byokServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        stream_options?: unknown;
        tools?: Array<{ function: { name: string } }>;
        messages?: Array<{ role: string; content: unknown; tool_name?: string; name?: string }>;
      };

      if (byokFaultMode === 'rate_limit_429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded (G1-S10)' }));
        return;
      }

      // Test automatic retry without stream_options on /strict-gateway
      if (req.url?.includes('/strict-gateway') && body.stream_options) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown parameter: stream_options' }));
        return;
      }

      const tools = body.tools ?? [];
      res.writeHead(200, { 'content-type': 'text/event-stream' });

      // Capability probe: tool ping
      if (tools.length === 1 && tools[0]!.function.name === 'jobhelper_capability_ping') {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                delta: {
                  tool_calls: [
                    { index: 0, id: 'probe_1', function: { name: 'jobhelper_capability_ping', arguments: '{"status":"ok"}' } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })}\n\ndata: [DONE]\n\n`,
        );
        res.end();
        return;
      }

      // Capability probe: basic or vision
      res.write(
        `data: ${JSON.stringify({
          choices: [{ finish_reason: 'stop', delta: { content: 'OK' } }],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`,
      );
      res.end();
    });

    await new Promise<void>((resolve) => byokServer.listen(0, '127.0.0.1', resolve));
    const addr = byokServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind BYOK mock server');
    byokBaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await mockAts.close();
    await new Promise<void>((resolve) => byokServer.close(() => resolve()));
  });

  it('G1-01 ~ G1-08: completes the full 8-step Gate 1 golden path with human takeover edit, PDF upload, review card, and verified receipt', async () => {
    mockAts.reset();
    byokFaultMode = 'ok';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhelper-gate1-golden-'));
    const viewsByTarget = new Map<string, LiveMockAtsView>();
    let viewSeq = 0;

    let kernel!: DesktopMainKernel;
    const kernelWorker = (): WorkerChildTransport => {
      const toMain: Array<(m: WorkerToMainMessage) => void> = [];
      const host = new SharedAgentWorkerHost({
        emit: (msg) => {
          for (const h of toMain) h(msg);
        },
        onRunStart: async ({ taskId, runId, epoch }) => runTaskTurnInKernel(kernel, taskId, runId, epoch),
      });
      setImmediate(() => host.signalReady());
      return {
        send: (msg: MainToWorkerMessage) => {
          void host.handleMainMessage(msg);
        },
        onMessage: (h) => toMain.push(h),
        onExit: () => {},
        kill: () => {},
      };
    };

    kernel = createDesktopMainKernel({
      dbPath: path.join(tmpDir, 'gate1.db'),
      materialsRootDir: path.join(tmpDir, 'materials'),
      artifactsRootDir: path.join(tmpDir, 'artifacts'),
      credentials: new InMemoryCredentialStore(),
      viewFactory: {
        createView: ({ initialBounds }) => {
          const tid = `g1-target-${++viewSeq}`;
          const v = new LiveMockAtsView(tid, mockAts, initialBounds);
          viewsByTarget.set(tid, v);
          return v;
        },
      },
      spawnWorker: kernelWorker,
      stopAckTimeoutMs: 200,
    });

    const handlers = new Map<string, (_e: unknown, arg: unknown) => Promise<unknown>>();
    registerDesktopIpcHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, kernel.ipcRouter);
    const api = createJobHelperPreloadApi({
      invoke: async (ch, arg) => handlers.get(ch)!({}, arg),
    });

    try {
      kernel.start();

      // G1-01: Configure BYOK (using strict-gateway to prove stream_options fallback!), probe, create profile & import test PDF
      const prov = await api['providers:save']({
        name: 'DeepSeek Flash 10.12 (Mock)',
        providerType: 'openai-compatible',
        baseUrl: `${byokBaseUrl}/strict-gateway/v1`,
        modelId: 'deepseek-flash-1012',
        apiKey: 'sk-gate1-secret',
        isDefault: true,
      });
      const probe = await api['providers:probe']({ providerId: prov.config.id });
      expect(probe.ok).toBe(true);
      expect(probe.capabilities?.streaming).toBe(true);
      expect(probe.capabilities?.toolCalling).toBe(true);
      expect(probe.capabilities?.vision).toBe(true);

      const { profile } = await api['profiles:create']({
        name: '虚构校招简历',
        content: FICTIONAL_PROFILE_A,
        setAsDefault: true,
      });
      const pdf = await api['materials:importBuffer']({
        profileId: profile.id,
        kind: 'resume_pdf',
        fileName: 'LinXinghe_Resume.pdf',
        mimeType: 'application/pdf',
        base64Data: Buffer.from('%PDF-1.4 gate1 test resume').toString('base64'),
      });
      await api['profiles:setDefaultResume']({ profileId: profile.id, materialId: pdf.id });

      // G1-02: Create job-001 task -> locked snapshot & authorized PDF; redirects to /login
      const { taskId, reused } = await api['tasks:startApplication']({
        applyUrl: `${mockAts.baseUrl}/apply/job-001`,
      });
      expect(reused).toBe(false);
      const view = viewsByTarget.get('g1-target-1')!;
      expect(view.webContents.getURL()).toContain('/login');

      // Stop automatic queued run so we drive deterministic step-by-step tool calls on the live engine
      await api['tasks:takeover']({ taskId });

      // G1-03: Observe login page -> password masked, password/captcha autofill blocked -> request_user_action(login)
      const epoch1 = kernel.leases.acquire(taskId);
      const run1 = 'run-g1-login' as RunId;
      kernel.storage.runs.create({
        id: run1,
        taskId,
        epoch: epoch1,
        providerSnapshot: {
          providerId: prov.config.id,
          providerName: prov.config.name,
          providerType: prov.config.providerType,
          baseUrl: prov.config.baseUrl,
          modelId: prov.config.modelId,
          capabilities: probe.capabilities!,
        },
        startedAt: new Date().toISOString() as IsoTimestamp,
      });
      kernel.taskService.transitionState({
        taskId,
        next: { executionState: 'queued', applicationStage: 'opened' },
        reason: 'g1_03_queue_login_observe',
        actor: 'system',
      });
      kernel.taskService.transitionState({
        taskId,
        next: { executionState: 'running', applicationStage: 'opened' },
        reason: 'g1_03_login_observe',
        actor: 'system',
      });

      const makeCtx = (runId: RunId, epoch: Epoch, callId: string, attentionLocked = false) => ({
        taskId,
        runId,
        epoch,
        callId: callId as CallId,
        role: 'application' as const,
        profileVersionId: kernel.storage.tasks.getById(taskId)!.profileVersionId,
        authorizedMaterialIds: [pdf.id],
        attentionLocked,
        signal: new AbortController().signal,
      });

      const loginObs = await kernel.agentEngine.registry.invoke('observe', {}, makeCtx(run1, epoch1, 'c1'));
      expect(loginObs.ok).toBe(true);
      const loginNodes = (loginObs.data as { nodes: Array<{ name?: string; value?: string; ref?: string }> }).nodes;
      const pwdNode = loginNodes.find((n) => n.name === '登录密码')!;
      expect(pwdNode.value).toBe('[密码]');

      // Guard blocks password autofill on login page
      const pwdFillAttempt = await kernel.agentEngine.registry.invoke(
        'act',
        { action: 'fill', ref: pwdNode.ref!, value: '123456' },
        makeCtx(run1, epoch1, 'c2'),
      );
      expect(pwdFillAttempt.ok).toBe(false);
      expect(pwdFillAttempt.error?.code).toBe('SUBMIT_GUARD_BLOCKED');

      const loginTodo = await kernel.agentEngine.registry.invoke(
        'request_user_action',
        { reason: 'login', summary: '请登录 MockCorp 招聘站', instructions: '在右侧网页输入密码和验证码完成登录' },
        makeCtx(run1, epoch1, 'c3'),
      );
      expect(loginTodo.ok).toBe(true);
      expect(loginTodo.locksAttention).toBe(true);
      kernel.leases.stop(taskId);

      const afterLoginWait = kernel.storage.tasks.getById(taskId)!;
      expect(afterLoginWait.executionState).toBe('waiting_user');
      expect(afterLoginWait.waitingReason).toBe('login');
      expect(afterLoginWait.applicationStage).toBe('opened');
      expect(afterLoginWait.outcome).toBe('not_submitted');

      // G1-04: Human logs into Mock ATS manually -> navigates to /apply/job-001 -> clicks resumeCheck
      const loginPost = await fetch(`${mockAts.baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'account=13800138000&password=123456&captcha=8848&next=/apply/job-001',
        redirect: 'manual',
      });
      expect(loginPost.status).toBe(302);
      await view.webContents.loadURL(`${mockAts.baseUrl}/apply/job-001`);
      expect(view.webContents.getURL()).toContain('/apply/job-001');

      await api['tasks:resumeCheck']({ taskId });
      await kernel.scheduler.cancel(taskId);
      const epoch2 = kernel.leases.acquire(taskId);
      const run2 = 'run-g1-fill' as RunId;
      kernel.storage.runs.create({
        id: run2,
        taskId,
        epoch: epoch2,
        providerSnapshot: {
          providerId: prov.config.id,
          providerName: prov.config.name,
          providerType: prov.config.providerType,
          baseUrl: prov.config.baseUrl,
          modelId: prov.config.modelId,
          capabilities: probe.capabilities!,
        },
        startedAt: new Date().toISOString() as IsoTimestamp,
      });
      kernel.taskService.transitionState({
        taskId,
        next: { executionState: 'running', applicationStage: 'filling' },
        reason: 'g1_04_filling',
        actor: 'system',
      });

      // Fill Name, Select City, Upload authorized PDF with readback verification
      const obsFill1 = await kernel.agentEngine.registry.invoke('observe', {}, makeCtx(run2, epoch2, 'c4'));
      const nameRef = (obsFill1.data as { nodes: Array<{ name?: string; ref?: string }> }).nodes.find(
        (n) => n.name === '姓名',
      )!.ref!;
      const fillName = await kernel.agentEngine.registry.invoke(
        'act',
        { action: 'fill', ref: nameRef, value: '林星河' },
        makeCtx(run2, epoch2, 'c5'),
      );
      expect(fillName.ok).toBe(true);
      expect((fillName.data as { readbackValue: string }).readbackValue).toBe('林星河');

      const obsFill2 = await kernel.agentEngine.registry.invoke('observe', {}, makeCtx(run2, epoch2, 'c6'));
      const cityRef = (obsFill2.data as { nodes: Array<{ name?: string; ref?: string }> }).nodes.find(
        (n) => n.name === '期望工作城市',
      )!.ref!;
      const selectCity = await kernel.agentEngine.registry.invoke(
        'act',
        { action: 'select', ref: cityRef, value: '上海' },
        makeCtx(run2, epoch2, 'c7'),
      );
      expect(selectCity.ok).toBe(true);

      const obsFill3 = await kernel.agentEngine.registry.invoke('observe', {}, makeCtx(run2, epoch2, 'c8'));
      const fileRef = (obsFill3.data as { nodes: Array<{ name?: string; ref?: string }> }).nodes.find(
        (n) => n.name === '附件简历',
      )!.ref!;
      const uploadRes = await kernel.agentEngine.registry.invoke(
        'act',
        { action: 'upload', ref: fileRef, materialId: pdf.id },
        makeCtx(run2, epoch2, 'c9'),
      );
      expect(uploadRes.ok).toBe(true);
      expect(view.uploadedFileName).toBe('LinXinghe_Resume.pdf');

      // G1-05: Missing field triggers ask_user_question -> user answers live via Preload IPC
      const askPromise = kernel.agentEngine.registry.invoke(
        'ask_user_question',
        { questions: [{ id: 'q-relocate', prompt: '是否接受短期出差？', options: ['接受', '不接受'] }] },
        makeCtx(run2, epoch2, 'c10'),
      );
      await new Promise((r) => setTimeout(r, 20));
      const pendingQ = kernel.storage.hitl.getPendingQuestionCard(taskId)!;
      expect(pendingQ).not.toBeNull();
      await api['tasks:answerQuestion']({
        taskId,
        questionCardId: pendingQ.id,
        answers: [{ questionId: 'q-relocate' as QuestionId, value: '接受', saveToProfile: true }],
      });
      const askResult = await askPromise;
      expect(askResult.ok).toBe(true);
      expect((askResult.data as { status: string; answers: Record<string, string> }).answers['q-relocate']).toBe(
        '接受',
      );

      const obsFill4 = await kernel.agentEngine.registry.invoke('observe', {}, makeCtx(run2, epoch2, 'c11'));
      const relocRef = (obsFill4.data as { nodes: Array<{ name?: string; ref?: string }> }).nodes.find(
        (n) => n.name === '是否接受短期出差',
      )!.ref!;
      await kernel.agentEngine.registry.invoke(
        'act',
        { action: 'fill', ref: relocRef, value: '接受' },
        makeCtx(run2, epoch2, 'c12'),
      );

      // G1-06: Human clicks takeover -> stale epoch rejected -> human modifies fullName on webpage -> resume observes new value!
      await api['tasks:takeover']({ taskId });
      await expect(kernel.browserController.observe(taskId, epoch2)).rejects.toThrow(/已暂停|过期/);

      // Human directly edits field in browser
      view.formValues.set('node-fullName', '林星河（人工修改版）');

      await api['tasks:resumeCheck']({ taskId });
      await kernel.scheduler.cancel(taskId);
      const epoch3 = kernel.leases.acquire(taskId);
      const run3 = 'run-g1-review' as RunId;
      kernel.storage.runs.create({
        id: run3,
        taskId,
        epoch: epoch3,
        providerSnapshot: {
          providerId: prov.config.id,
          providerName: prov.config.name,
          providerType: prov.config.providerType,
          baseUrl: prov.config.baseUrl,
          modelId: prov.config.modelId,
          capabilities: probe.capabilities!,
        },
        startedAt: new Date().toISOString() as IsoTimestamp,
      });
      kernel.taskService.transitionState({
        taskId,
        next: { executionState: 'running' },
        reason: 'g1_06_resumed',
        actor: 'system',
      });

      const obsAfterHuman = await kernel.agentEngine.registry.invoke('observe', {}, makeCtx(run3, epoch3, 'c13'));
      const observedName = (obsAfterHuman.data as { nodes: Array<{ name?: string; value?: string }> }).nodes.find(
        (n) => n.name === '姓名',
      )!.value;
      expect(observedName).toBe('林星河（人工修改版）');

      // G1-07: Capture confirmation screenshot + report_filling_ready + request_submission_confirmation
      const shotRes = await kernel.agentEngine.registry.invoke(
        'capture_confirmation_screenshot',
        { label: '提交前核对截图' },
        makeCtx(run3, epoch3, 'c14'),
      );
      expect(shotRes.ok).toBe(true);
      await kernel.agentEngine.registry.invoke(
        'report_filling_ready',
        { filledSummary: '姓名、城市、出差意愿与 PDF 简历已填完核对', attachmentIds: [pdf.id] },
        makeCtx(run3, epoch3, 'c15'),
      );
      const confRes = await kernel.agentEngine.registry.invoke(
        'request_submission_confirmation',
        {
          company: 'MockCorp 科技',
          jobTitle: '前端开发工程师（2027校招）',
          keyFields: [
            { label: '姓名', value: '林星河（人工修改版）' },
            { label: '期望工作城市', value: '上海' },
          ],
          attachmentIds: [pdf.id],
          screenshotArtifactIds: [(shotRes.data as { artifactId: string }).artifactId],
          contentHash: 'sha256-g1-final-v1',
        },
        makeCtx(run3, epoch3, 'c16'),
      );
      expect(confRes.ok).toBe(true);
      expect(confRes.locksAttention).toBe(true);
      kernel.leases.stop(taskId);

      const beforeManualSubmit = kernel.storage.tasks.getById(taskId)!;
      expect(beforeManualSubmit.executionState).toBe('waiting_user');
      expect(beforeManualSubmit.waitingReason).toBe('submission_confirmation');
      expect(beforeManualSubmit.applicationStage).toBe('filling_ready');
      expect(beforeManualSubmit.outcome).toBe('not_submitted');

      // G1-08: Human manually clicks submit on webpage (mode=success) -> read-only receipt check -> submitted_verified
      const submitResult = await view.simulateHumanManualSubmit('job-001');
      expect(submitResult.status).toBe(200);
      expect(submitResult.receiptId).toBe('APP-2026-0001');
      expect(mockAts.getState().submissions).toHaveLength(1);
      expect(mockAts.getState().submissions[0]!.fields.fullName).toBe('林星河（人工修改版）');

      const epoch4 = kernel.leases.acquire(taskId);
      const run4 = 'run-g1-verify' as RunId;
      kernel.storage.runs.create({
        id: run4,
        taskId,
        epoch: epoch4,
        providerSnapshot: {
          providerId: prov.config.id,
          providerName: prov.config.name,
          providerType: prov.config.providerType,
          baseUrl: prov.config.baseUrl,
          modelId: prov.config.modelId,
          capabilities: probe.capabilities!,
        },
        startedAt: new Date().toISOString() as IsoTimestamp,
      });
      kernel.taskService.transitionState({
        taskId,
        next: { executionState: 'queued', applicationStage: 'verifying' },
        reason: 'g1_08_queue_verify_receipt',
        actor: 'system',
      });
      kernel.taskService.transitionState({
        taskId,
        next: { executionState: 'running', applicationStage: 'verifying' },
        reason: 'g1_08_verify_receipt',
        actor: 'system',
      });

      const receiptObs = await kernel.agentEngine.registry.invoke('observe', {}, makeCtx(run4, epoch4, 'c17'));
      const receiptText = (receiptObs.data as { nodes: Array<{ name?: string }> }).nodes[0]!.name!;
      expect(receiptText).toContain('投递成功');
      expect(receiptText).toContain('APP-2026-0001');

      const verifyRes = await kernel.agentEngine.registry.invoke(
        'report_submission_result',
        { verified: true, receiptText, receiptUrl: view.webContents.getURL() },
        makeCtx(run4, epoch4, 'c18'),
      );
      expect(verifyRes.ok).toBe(true);
      kernel.leases.stop(taskId);

      const finalTask = kernel.storage.tasks.getById(taskId)!;
      expect(finalTask.executionState).toBe('closed');
      expect(finalTask.applicationStage).toBe('done');
      expect(finalTask.outcome).toBe('submitted_verified');

      const pos = kernel.storage.positions.getById(finalTask.positionId!)!;
      expect(pos.progressStage).toBe('submitted_verified');
    } finally {
      await kernel.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('G1-S01 ~ G1-S10: passes all 10 Gate 1 security, timeout, crash-recovery, isolation, and dedup boundary tests', async () => {
    mockAts.reset();
    await fetch(`${mockAts.baseUrl}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loggedIn: true }),
    });
    byokFaultMode = 'ok';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhelper-gate1-sec-'));
    const dbPath = path.join(tmpDir, 'gate1-sec.db');
    const materialsDir = path.join(tmpDir, 'materials');
    const views = new Map<string, LiveMockAtsView>();
    let seq = 0;

    let kernel!: DesktopMainKernel;
    const makeTransport = (): WorkerChildTransport => {
      const toMain: Array<(m: WorkerToMainMessage) => void> = [];
      const host = new SharedAgentWorkerHost({
        emit: (m) => {
          for (const h of toMain) h(m);
        },
        onRunStart: async ({ taskId, runId, epoch }) => runTaskTurnInKernel(kernel, taskId, runId, epoch),
      });
      setImmediate(() => host.signalReady());
      return {
        send: (m: MainToWorkerMessage) => {
          void host.handleMainMessage(m);
        },
        onMessage: (h) => toMain.push(h),
        onExit: () => {},
        kill: () => {},
      };
    };

    kernel = createDesktopMainKernel({
      dbPath,
      materialsRootDir: materialsDir,
      credentials: new InMemoryCredentialStore(),
      viewFactory: {
        createView: ({ initialBounds }) => {
          const tid = `sec-target-${++seq}`;
          const v = new LiveMockAtsView(tid, mockAts, initialBounds);
          views.set(tid, v);
          return v;
        },
      },
      spawnWorker: makeTransport,
      stopAckTimeoutMs: 150,
    });

    try {
      kernel.start();

      // Setup Profile A (default) and Profile B
      const { profile: profA, snapshot: snapA } = kernel.profiles.createProfile({
        name: '档案A',
        content: FICTIONAL_PROFILE_A,
        setAsDefault: true,
      });

      // G1-S08: Repeated startApplication on job-001 reuses original taskId
      const start1 = await kernel.ipcRouter['tasks:startApplication']({
        applyUrl: `${mockAts.baseUrl}/apply/job-001`,
        profileId: profA.id,
      });
      const startDup = await kernel.ipcRouter['tasks:startApplication']({
        applyUrl: `${mockAts.baseUrl}/apply/job-001?utm_source=test`,
      });
      expect(startDup.reused).toBe(true);
      expect(startDup.taskId).toBe(start1.taskId);

      // G1-S07 & G1-S09: Switch global default to Profile B & start job-002 -> strict profile & CDP isolation
      const { profile: profB, snapshot: snapB } = kernel.profiles.createProfile({
        name: '档案B',
        content: FICTIONAL_PROFILE_B,
        setAsDefault: true,
      });
      const start2 = await kernel.ipcRouter['tasks:startApplication']({
        applyUrl: `${mockAts.baseUrl}/apply/job-002`,
      });
      expect(kernel.storage.tasks.getById(start1.taskId)?.profileVersionId).toBe(snapA.id);
      expect(kernel.storage.tasks.getById(start2.taskId)?.profileVersionId).toBe(snapB.id);
      expect(profB.id).not.toBe(profA.id);

      // Verify CDP isolation between job-001 and job-002
      const ep1 = kernel.leases.acquire(start1.taskId);
      const ep2 = kernel.leases.acquire(start2.taskId);
      const wsUrl1 = await kernel.cdpBridge.issueEndpoint(start1.taskId, ep1);
      const ws1 = new WebSocket(wsUrl1);
      await new Promise<void>((res) => ws1.once('open', res));
      const targetsReply = await new Promise<{ result: { targetInfos: Array<{ targetId: string }> } }>((res) => {
        ws1.once('message', (raw) => res(JSON.parse(raw.toString('utf8'))));
        ws1.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      });
      expect(targetsReply.result.targetInfos.map((t) => t.targetId)).toEqual(['sec-target-1']);
      ws1.terminate();

      // G1-S02: Submit Hard-Guard blocks ref click, Enter, coordinate click, arbitrary JS -> 0 submissions on server
      const obs = await kernel.browserController.observe(start1.taskId, ep1);
      const submitRef = obs.nodes.find((n) => n.name === '提交申请')!.ref!;
      expect((await kernel.browserController.act({ taskId: start1.taskId, epoch: ep1, action: 'click', ref: submitRef })).ok).toBe(false);
      expect((await kernel.browserController.act({ taskId: start1.taskId, epoch: ep1, action: 'press', key: 'Enter' })).ok).toBe(false);
      expect((await kernel.browserController.act({ taskId: start1.taskId, epoch: ep1, action: 'click', point: { x: 300, y: 400 } })).ok).toBe(false);
      expect(kernel.submitGuard.evaluateRawJsExpression().allowed).toBe(false);
      expect(mockAts.getState().submissions).toHaveLength(0);

      // G1-S01 & G1-S03: Create confirmation card -> takeover revokes ep1 & resume invalidates confirmation
      const runS = 'run-sec-1' as RunId;
      kernel.storage.runs.create({
        id: runS,
        taskId: start1.taskId,
        epoch: ep1,
        providerSnapshot: {
          providerId: 'p' as never,
          providerName: 'Mock',
          providerType: 'openai-compatible',
          baseUrl: byokBaseUrl,
          modelId: 'm',
          capabilities: { streaming: true, toolCalling: true, vision: false },
        },
        startedAt: new Date().toISOString() as IsoTimestamp,
      });
      const conf = kernel.confirmations.createConfirmation({
        taskId: start1.taskId,
        runId: runS,
        operation: 'final_submit',
        contentHash: 'hash-s03' as ContentHash,
        summary: { keyFields: [], missingItems: [], attachmentIds: [], screenshotArtifactIds: [] },
      });
      await kernel.taskService.requestTakeover(start1.taskId);
      await expect(kernel.browserController.observe(start1.taskId, ep1)).rejects.toThrow(/已暂停|过期/);
      await kernel.taskService.resumeAfterCheck(start1.taskId);
      expect(kernel.storage.hitl.getConfirmation(conf.id)?.status).toBe('invalidated');

      // G1-S04: Receipt timeout (mode=timeout, HTTP 504) -> stays verifying/unknown, NEVER auto-resubmits
      mockAts.setSubmitMode('timeout');
      const view1 = views.get('sec-target-1')!;
      const timeoutSubmit = await view1.simulateHumanManualSubmit('job-001');
      expect(timeoutSubmit.status).toBe(504);
      expect(mockAts.getState().submissions).toHaveLength(1);

      const epTimeout = kernel.leases.acquire(start1.taskId);
      kernel.taskService.transitionState({
        taskId: start1.taskId,
        next: { executionState: 'running' },
        reason: 'g1_s04_verify_run',
        actor: 'system',
      });
      await kernel.agentEngine.registry.invoke(
        'report_submit_attempted',
        { source: 'user_manual', evidenceNote: '用户点击了提交但接口 504 超时' },
        {
          taskId: start1.taskId,
          runId: runS,
          epoch: epTimeout,
          callId: 'c-s04-a' as CallId,
          role: 'application',
          authorizedMaterialIds: [],
          attentionLocked: false,
          signal: new AbortController().signal,
        },
      );
      await kernel.agentEngine.registry.invoke(
        'report_submission_result',
        { verified: false },
        {
          taskId: start1.taskId,
          runId: runS,
          epoch: epTimeout,
          callId: 'c-s04-b' as CallId,
          role: 'application',
          authorizedMaterialIds: [],
          attentionLocked: false,
          signal: new AbortController().signal,
        },
      );
      kernel.leases.stop(start1.taskId);
      const tTimeout = kernel.storage.tasks.getById(start1.taskId)!;
      expect(tTimeout.executionState).toBe('waiting_user');
      expect(tTimeout.waitingReason).toBe('result_check');
      expect(tTimeout.applicationStage).toBe('verifying');
      expect(tTimeout.outcome).toBe('unknown');
      expect(mockAts.getState().submissions).toHaveLength(1); // NEVER re-submitted

      // G1-S06: Question timeout & late answer binds original questionId and requeues
      kernel.leases.stop(start2.taskId);
      const runQ = 'run-sec-q' as RunId;
      kernel.storage.runs.create({
        id: runQ,
        taskId: start2.taskId,
        epoch: ep2,
        providerSnapshot: {
          providerId: 'p' as never,
          providerName: 'Mock',
          providerType: 'openai-compatible',
          baseUrl: byokBaseUrl,
          modelId: 'm',
          capabilities: { streaming: true, toolCalling: true, vision: false },
        },
        startedAt: new Date().toISOString() as IsoTimestamp,
      });
      kernel.storage.hitl.saveQuestionCard({
        id: 'qcard-late',
        taskId: start2.taskId,
        runId: runQ,
        callId: 'call-late' as CallId,
        questions: [{ id: 'q-late' as QuestionId, prompt: '毕业设计题目', allowFreeText: true, saveToProfileDefault: true }],
        status: 'expired_pending',
        createdAt: new Date().toISOString() as IsoTimestamp,
      });
      await kernel.taskService.answerQuestion({
        taskId: start2.taskId,
        questionCardId: 'qcard-late',
        answers: [{ questionId: 'q-late' as QuestionId, value: '大模型代理安全架构', saveToProfile: true }],
      });
      expect(kernel.storage.hitl.getQuestionCard('qcard-late')?.status).toBe('answered');

      // G1-S10: BYOK 429 rate-limit -> run returns model_error, preserving history cleanly
      byokFaultMode = 'rate_limit_429';
      const prov429 = await kernel.ipcRouter['providers:save']({
        name: 'RateLimited Provider',
        providerType: 'openai-compatible',
        baseUrl: `${byokBaseUrl}/v1`,
        modelId: 'deepseek-flash-1012',
        apiKey: 'sk-429',
        isDefault: true,
      });
      kernel.storage.providers.upsert({
        ...prov429.config,
        capabilities: { streaming: true, toolCalling: true, vision: true },
      });
      const ep429 = kernel.leases.acquire(start2.taskId);
      const run429 = 'run-429' as RunId;
      const res429 = await runTaskTurnInKernel(kernel, start2.taskId, run429, ep429);
      expect(res429.endReason).toBe('model_error');
      expect(res429.error).toMatch(/429|限流/);
      kernel.leases.stop(start2.taskId);

      // G1-S05: Force-quit / restart while running -> recovers cleanly to interrupted, zero replayed writes
      kernel.taskService.transitionState({
        taskId: start2.taskId,
        next: { executionState: 'running' },
        reason: 'simulate_crash_before_restart',
        actor: 'system',
      });
      await kernel.shutdown();

      const reopened = createDesktopMainKernel({
        dbPath,
        materialsRootDir: materialsDir,
        credentials: new InMemoryCredentialStore(),
        viewFactory: {
          createView: ({ initialBounds }) => new LiveMockAtsView('reopened', mockAts, initialBounds),
        },
        spawnWorker: makeTransport,
      });
      try {
        const { recoveredTaskIds } = reopened.start();
        expect(recoveredTaskIds).toContain(start2.taskId);
        expect(reopened.storage.tasks.getById(start2.taskId)?.executionState).toBe('interrupted');
        // Receipt-timeout task also preserved in verifying/unknown!
        expect(reopened.storage.tasks.getById(start1.taskId)?.outcome).toBe('unknown');
        expect(mockAts.getState().submissions).toHaveLength(1);
      } finally {
        await reopened.shutdown();
      }
    } finally {
      try {
        await kernel.shutdown();
      } catch {
        // already shut down before restart check
      }
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
