import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { BrowserProfileId, Epoch, TaskId, ViewportRect } from '@jobhelper/contracts';
import { TaskControls } from '@jobhelper/core';
import {
  DefaultSubmitHardGuard,
  LocalScopedCdpBridge,
  LocalTaskTabManager,
  ScopedBrowserController,
  type ManagedDebugger,
  type ManagedWebContents,
  type ManagedWebContentsView,
  type WebContentsViewFactory,
} from '../src/index.js';

/**
 * Deterministic in-process mock WebContentsView supporting AXTree, DOM metadata,
 * fill/select readback, and CDP debugger message dispatch.
 */
class FakeWebContentsView implements ManagedWebContentsView {
  private bounds: ViewportRect;
  private visible = false;
  private destroyed = false;
  private url = '';
  private title = 'Mock Recruitment Form';
  private attached = false;
  private readonly emitter = new EventEmitter();
  private readonly dbgEmitter = new EventEmitter();

  public fieldValues = new Map<string, string>([
    ['node-name', ''],
    ['node-city', 'shanghai'],
  ]);
  public dispatchedClicks = 0;
  public dispatchedKeys: string[] = [];

  readonly webContents: ManagedWebContents;

  constructor(
    public readonly targetId: string,
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
      on: (event, listener) => {
        this.dbgEmitter.on(event, listener);
      },
      removeListener: (event, listener) => {
        this.dbgEmitter.removeListener(event, listener);
      },
    };

    this.webContents = {
      isDestroyed: () => this.destroyed,
      getURL: () => this.url,
      getTitle: () => this.title,
      getUserAgent: () => 'JobHelperTest/1.0',
      getZoomFactor: () => 1,
      loadURL: async (nextUrl) => {
        this.emitter.emit('did-start-navigation');
        this.url = nextUrl;
        this.emitter.emit('did-navigate');
        this.emitter.emit('did-stop-loading');
      },
      executeJavaScript: async () => undefined as never,
      capturePagePngBase64: async () => ({ base64: 'iVBORw0KGgo=', width: 1280, height: 800 }),
      debugger: dbg,
      on: (event, listener) => {
        this.emitter.on(event, listener);
      },
      removeListener: (event, listener) => {
        this.emitter.removeListener(event, listener);
      },
    };
  }

  private focusedNodeKey = 'node-name';

  private async handleCdp(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === 'Target.getTargetInfo') {
      return { targetInfo: { targetId: this.targetId } };
    }
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            backendDOMNodeId: 101,
            role: { value: 'textbox' },
            name: { value: '姓名' },
            value: { value: this.fieldValues.get('node-name') ?? '' },
          },
          {
            backendDOMNodeId: 102,
            role: { value: 'textbox' },
            name: { value: '登录密码' },
            value: { value: 'super-secret-pass' },
            properties: [{ name: 'protected', value: { value: true } }],
          },
          {
            backendDOMNodeId: 103,
            role: { value: 'button' },
            name: { value: '提交申请' },
          },
          {
            backendDOMNodeId: 104,
            role: { value: 'button' },
            name: { value: '保存草稿' },
          },
        ],
      };
    }
    if (method === 'DOM.resolveNode') {
      const id = Number(params.backendNodeId);
      const map: Record<number, string> = {
        101: 'node-name',
        102: 'node-pwd',
        103: 'node-submit',
        104: 'node-save',
      };
      return { object: { objectId: map[id] } };
    }
    if (method === 'Runtime.callFunctionOn') {
      const objId = String(params.objectId);
      const fn = String(params.functionDeclaration);
      if (fn.includes('accessibleLabel')) {
        if (objId === 'node-name') {
          return {
            result: {
              value: {
                tagName: 'INPUT',
                inputType: 'text',
                accessibleLabel: '姓名',
                fieldIdentityText: 'fullName',
                inForm: true,
                inCrossOriginIframe: false,
              },
            },
          };
        }
        if (objId === 'node-pwd') {
          return {
            result: {
              value: {
                tagName: 'INPUT',
                inputType: 'password',
                accessibleLabel: '登录密码',
                fieldIdentityText: 'password',
                inForm: true,
                inCrossOriginIframe: false,
              },
            },
          };
        }
        if (objId === 'node-submit') {
          return {
            result: {
              value: {
                tagName: 'BUTTON',
                buttonType: 'submit',
                accessibleLabel: '提交申请',
                inForm: true,
                inCrossOriginIframe: false,
              },
            },
          };
        }
        if (objId === 'node-save') {
          return {
            result: {
              value: {
                tagName: 'BUTTON',
                buttonType: 'button',
                accessibleLabel: '保存草稿',
                inForm: true,
                inCrossOriginIframe: false,
              },
            },
          };
        }
      }
      if (fn.includes('this.focus()')) {
        this.focusedNodeKey = objId;
        return { result: { value: true } };
      }
      if (fn.includes('return this.value')) {
        return { result: { value: this.fieldValues.get(objId) ?? '' } };
      }
      if (fn.includes('getBoundingClientRect')) {
        return { result: { value: { x: 200, y: 300 } } };
      }
      return { result: { value: undefined } };
    }
    if (method === 'Input.insertText') {
      this.fieldValues.set(this.focusedNodeKey, String(params.text ?? ''));
      return {};
    }
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mouseReleased') this.dispatchedClicks++;
      return {};
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.type === 'keyDown') this.dispatchedKeys.push(String(params.key));
      return {};
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('elementFromPoint(500, 600)')) {
        // Coordinate hits submit button!
        return {
          result: {
            value: {
              tagName: 'BUTTON',
              buttonType: 'submit',
              accessibleLabel: '确认投递',
              inForm: true,
              inCrossOriginIframe: false,
            },
          },
        };
      }
      if (expr.includes('elementFromPoint(700, 700)')) {
        // Coordinate hits cross-origin iframe!
        return {
          result: {
            value: { tagName: 'IFRAME', inCrossOriginIframe: true },
          },
        };
      }
      if (expr.includes('document.activeElement')) {
        return { result: { value: { tagName: 'INPUT', inForm: true } } };
      }
      return { result: { value: {} } };
    }
    if (method === 'Runtime.releaseObjectGroup') {
      return {};
    }
    return { ok: true, method };
  }

  setBounds(bounds: ViewportRect): void {
    this.bounds = { ...bounds };
  }
  getBounds(): ViewportRect {
    return { ...this.bounds };
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
  getVisible(): boolean {
    return this.visible;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function sendCdpRpc(
  ws: WebSocket,
  id: number,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<{ id: number; result?: Record<string, unknown>; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const onMsg = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(raw.toString('utf8')) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (parsed.id === id) {
        ws.off('message', onMsg);
        resolve(parsed as { id: number; result?: Record<string, unknown>; error?: { message: string } });
      }
    };
    ws.on('message', onMsg);
    ws.once('error', reject);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

describe('@jobhelper/browser-bridge M2 Gate (Scoped CDP + Submit Hard-Guard + Epoch Fencing)', () => {
  it('isolates CDP targets strictly per taskId, rejects stale epochs immediately, and closes peer without affecting other tasks', async () => {
    const leases = new TaskControls();
    let viewCounter = 0;
    const views: FakeWebContentsView[] = [];
    const viewFactory: WebContentsViewFactory = {
      createView: ({ initialBounds }) => {
        const v = new FakeWebContentsView(`target-${++viewCounter}`, initialBounds);
        views.push(v);
        return v;
      },
    };

    const tabs = new LocalTaskTabManager({ viewFactory });
    const bridge = new LocalScopedCdpBridge({
      getTabs: (taskId) => tabs.getManagedTabs(taskId),
      assertActive: (taskId, epoch) => leases.assert(taskId, epoch),
      createTab: async (taskId, url) => {
        const info = await tabs.createTab(taskId, url, 'default' as BrowserProfileId);
        return tabs.getManagedTabs(taskId).find((t) => t.id === info.id)!;
      },
      selectTab: (taskId, tabId) => tabs.selectTab(taskId, tabId),
      closeTab: (taskId, tabId) => tabs.closeTab(taskId, tabId),
    });

    const taskA = 'task-A' as TaskId;
    const taskB = 'task-B' as TaskId;
    await tabs.createTab(taskA, 'https://a.example.com/job/1', 'default' as BrowserProfileId);
    await tabs.createTab(taskB, 'https://b.example.com/job/2', 'default' as BrowserProfileId);

    const epochA = leases.acquire(taskA);
    const epochB = leases.acquire(taskB);

    const urlA = await bridge.issueEndpoint(taskA, epochA);
    const urlB = await bridge.issueEndpoint(taskB, epochB);

    const wsA = new WebSocket(urlA);
    const wsB = new WebSocket(urlB);
    await Promise.all([
      new Promise<void>((res) => wsA.once('open', res)),
      new Promise<void>((res) => wsB.once('open', res)),
    ]);

    try {
      // Task A can ONLY see target-1, never target-2
      const targetsA = await sendCdpRpc(wsA, 1, 'Target.getTargets');
      const idsA = (targetsA.result?.targetInfos as Array<{ targetId: string }>).map((t) => t.targetId);
      expect(idsA).toEqual(['target-1']);

      // Task A attempting to attach to Task B's target-2 is rejected
      const crossAttach = await sendCdpRpc(wsA, 2, 'Target.attachToTarget', { targetId: 'target-2' });
      expect(crossAttach.error?.message).toMatch(/不属于本任务/);

      // Task A cannot resize app window
      const resizeAttempt = await sendCdpRpc(wsA, 3, 'Browser.setWindowBounds', {});
      expect(resizeAttempt.error?.message).toMatch(/桌面界面管理/);

      // Stopping Task A revokes lease & drops wsA immediately, while Task B remains fully alive
      const wsAClosed = new Promise<void>((res) => wsA.once('close', () => res()));
      leases.stop(taskA);
      bridge.revokeTask(taskA);
      await wsAClosed;

      // Reconnecting with stale URL/epoch fails upgrade
      const staleReconnect = new Promise<boolean>((res) => {
        const wsStale = new WebSocket(urlA);
        wsStale.once('error', () => res(true));
        wsStale.once('open', () => {
          wsStale.close();
          res(false);
        });
      });
      expect(await staleReconnect).toBe(true);

      // Task B still works completely unaffected
      const targetsB = await sendCdpRpc(wsB, 1, 'Target.getTargets');
      const idsB = (targetsB.result?.targetInfos as Array<{ targetId: string }>).map((t) => t.targetId);
      expect(idsB).toEqual(['target-2']);
    } finally {
      wsA.terminate();
      wsB.terminate();
      await bridge.close();
    }
  });

  it('enforces Submit Hard-Guard on all paths (click, Enter, coordinates, cross-iframe, password, script) and verifies fill readback & stale epoch', async () => {
    const leases = new TaskControls();
    let createdView!: FakeWebContentsView;
    const tabs = new LocalTaskTabManager({
      viewFactory: {
        createView: ({ initialBounds }) => {
          createdView = new FakeWebContentsView('target-form', initialBounds);
          return createdView;
        },
      },
    });
    const guard = new DefaultSubmitHardGuard({ mode: 'manual_only' });
    const controller = new ScopedBrowserController({
      tabs,
      assertActive: (taskId, epoch) => leases.assert(taskId, epoch),
      submitGuard: guard,
    });

    const taskId = 'task-form' as TaskId;
    await tabs.createTab(taskId, 'https://ats.example.com/apply/1', 'default' as BrowserProfileId);
    const epoch = leases.acquire(taskId);

    // 1. Observe masks password field value as [密码]
    const obs1 = await controller.observe(taskId, epoch);
    const nameNode = obs1.nodes.find((n) => n.name === '姓名');
    const pwdNode = obs1.nodes.find((n) => n.name === '登录密码');
    const submitNode = obs1.nodes.find((n) => n.name === '提交申请');
    const saveNode = obs1.nodes.find((n) => n.name === '保存草稿');

    expect(pwdNode?.value).toBe('[密码]');
    expect(pwdNode?.masked).toBe(true);
    expect(nameNode?.ref).toBeTruthy();

    // 2. Normal fill succeeds and verifies readback
    const fillRes = await controller.act({
      taskId,
      epoch,
      action: 'fill',
      ref: nameNode!.ref!,
      value: '林星河',
    });
    expect(fillRes.ok).toBe(true);
    expect(fillRes.readbackValue).toBe('林星河');

    // Stale ref from generation before mutation is rejected
    await expect(
      controller.act({
        taskId,
        epoch,
        action: 'click',
        ref: saveNode!.ref!,
      }),
    ).rejects.toThrow(/ref 已失效/);

    // 3. Re-observe & test ALL Submit Hard-Guard paths
    const obs2 = await controller.observe(taskId, epoch);
    const submitRef2 = obs2.nodes.find((n) => n.name === '提交申请')!.ref!;
    const pwdRef2 = obs2.nodes.find((n) => n.name === '登录密码')!.ref!;

    // Path A: Ref click on submit button blocked
    const submitClick = await controller.act({
      taskId,
      epoch,
      action: 'click',
      ref: submitRef2,
    });
    expect(submitClick.ok).toBe(false);
    expect(submitClick.guardBlocked?.matchedRule).toBe('submit_label');
    expect(createdView.dispatchedClicks).toBe(0);

    // Path B: Enter key inside form blocked
    const enterPress = await controller.act({
      taskId,
      epoch,
      action: 'press',
      key: 'Enter',
    });
    expect(enterPress.ok).toBe(false);
    expect(enterPress.guardBlocked?.matchedRule).toBe('form_enter_key');
    expect(createdView.dispatchedKeys).toEqual([]);

    // Path C: Coordinate click hitting submit button blocked
    const coordSubmit = await controller.act({
      taskId,
      epoch,
      action: 'click',
      point: { x: 500, y: 600 },
    });
    expect(coordSubmit.ok).toBe(false);
    expect(coordSubmit.guardBlocked?.matchedRule).toBe('submit_label');
    expect(createdView.dispatchedClicks).toBe(0);

    // Path D: Coordinate click hitting cross-origin iframe blocked
    const coordIframe = await controller.act({
      taskId,
      epoch,
      action: 'click',
      point: { x: 700, y: 700 },
    });
    expect(coordIframe.ok).toBe(false);
    expect(coordIframe.guardBlocked?.matchedRule).toBe('cross_iframe_click');

    // Path E: Password field autofill blocked
    const obs3 = await controller.observe(taskId, epoch);
    const pwdRef3 = obs3.nodes.find((n) => n.name === '登录密码')!.ref!;
    expect(pwdRef2).not.toBe(pwdRef3);
    const pwdFill = await controller.act({
      taskId,
      epoch,
      action: 'fill',
      ref: pwdRef3,
      value: '123456',
    });
    expect(pwdFill.ok).toBe(false);
    expect(pwdFill.guardBlocked?.matchedRule).toBe('password_or_captcha_field');

    // Path F: Arbitrary JS script expression blocked
    expect(guard.evaluateRawJsExpression().allowed).toBe(false);
    expect(guard.evaluateScriptProbe('eval_submit').allowed).toBe(false);
    expect(guard.evaluateScriptProbe('form_errors').allowed).toBe(true);

    // 4. Stale epoch rejected immediately after lease stop
    leases.stop(taskId);
    await expect(controller.observe(taskId, epoch)).rejects.toThrow(/已暂停|过期/);
    await expect(
      controller.act({ taskId, epoch: 'forged-epoch' as Epoch, action: 'scroll', dy: 200 }),
    ).rejects.toThrow(/已暂停|过期/);
  });
});
