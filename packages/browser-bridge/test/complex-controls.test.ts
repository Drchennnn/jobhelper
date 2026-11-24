import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type {
  BrowserProfileId,
  Epoch,
  MaterialId,
  TaskId,
  ViewportRect,
} from '@jobhelper/contracts';
import { TaskControls } from '@jobhelper/core';
import {
  DefaultSubmitHardGuard,
  LocalTaskTabManager,
  ScopedBrowserController,
  type ManagedDebugger,
  type ManagedWebContents,
  type ManagedWebContentsView,
  type WebContentsViewFactory,
} from '../src/index.js';

class ComplexControlMockView implements ManagedWebContentsView {
  private bounds: ViewportRect;
  private visible = false;
  private destroyed = false;
  private url = 'https://app.mokahr.com/campus/apply/demo';
  private title = 'Moka Complex Form';
  private attached = false;
  private readonly emitter = new EventEmitter();
  private readonly dbgEmitter = new EventEmitter();

  public insertedSearchTexts: string[] = [];
  public clickedCoords: Array<{ x: number; y: number }> = [];
  public uploadedPaths: string[] = [];
  public triggerDisplayText = '请选择';
  public uploadedFileNames: string[] = [];
  public simulateSubmitOption = false;

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
            backendDOMNodeId: 201,
            role: { value: 'combobox' },
            name: { value: '期望工作地' },
            value: { value: this.triggerDisplayText },
          },
          {
            backendDOMNodeId: 202,
            role: { value: 'textbox' },
            name: { value: '入学时间' },
            value: { value: '' },
          },
          {
            backendDOMNodeId: 203,
            role: { value: 'textbox' },
            name: { value: '登录密码' },
            value: { value: 'secret-123' },
            properties: [{ name: 'protected', value: { value: true } }],
          },
          {
            backendDOMNodeId: 204,
            role: { value: 'button' },
            name: { value: '上传补充证书' },
          },
          {
            backendDOMNodeId: 205,
            role: { value: 'button' },
            name: { value: '提交申请' },
          },
        ],
      };
    }

    if (method === 'DOM.resolveNode') {
      const bid = Number(params.backendNodeId);
      return { object: { objectId: `obj-${bid}` } };
    }

    if (method === 'DOM.setFileInputFiles') {
      const files = (params.files as string[]) ?? [];
      this.uploadedPaths = files;
      this.uploadedFileNames = files.map((p) => p.split(/[\\/]/).pop() ?? p);
      return {};
    }

    if (method === 'Input.insertText') {
      this.insertedSearchTexts.push(String(params.text ?? ''));
      return {};
    }

    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') {
        this.clickedCoords.push({ x: Number(params.x), y: Number(params.y) });
      }
      return {};
    }

    if (method === 'Runtime.releaseObjectGroup') {
      return {};
    }

    if (method === 'Runtime.callFunctionOn') {
      const objId = String(params.objectId ?? '');
      const fn = String(params.functionDeclaration ?? '');

      if (fn.includes('optionsPreview')) {
        if (objId === 'obj-202') {
          return {
            result: {
              value: {
                tagName: 'INPUT',
                inputType: 'text',
                accessibleLabel: '入学时间',
                placeholder: 'YYYY-MM',
                readOnly: true,
                disabled: false,
                required: true,
                inForm: true,
                inCrossOriginIframe: false,
              },
            },
          };
        }
        if (objId === 'obj-203') {
          return {
            result: {
              value: {
                tagName: 'INPUT',
                inputType: 'password',
                accessibleLabel: '登录密码',
                value: '[密码]',
                masked: true,
                readOnly: false,
                disabled: false,
                required: true,
                inForm: true,
                inCrossOriginIframe: false,
                fieldIdentityText: 'password',
              },
            },
          };
        }
        if (objId === 'obj-205') {
          return {
            result: {
              value: {
                tagName: 'BUTTON',
                buttonType: 'submit',
                accessibleLabel: '提交申请',
                readOnly: false,
                disabled: false,
                required: false,
                inForm: true,
                inCrossOriginIframe: false,
              },
            },
          };
        }
      }

      if (fn.includes('inCrossOriginIframe')) {
        if (objId === 'obj-201') {
          return {
            result: {
              value: {
                tagName: 'DIV',
                accessibleLabel: '期望工作地',
                inForm: true,
                inCrossOriginIframe: false,
                fieldIdentityText: 'city-cascader',
              },
            },
          };
        }
        if (objId === 'obj-204') {
          return {
            result: {
              value: {
                tagName: 'INPUT',
                inputType: 'file',
                accessibleLabel: '上传补充证书',
                inForm: true,
                inCrossOriginIframe: false,
              },
            },
          };
        }
        if (objId === 'obj-205') {
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
      }

      if (fn.includes('getBoundingClientRect')) {
        return { result: { value: { x: 100, y: 120 } } };
      }

      if (fn.includes('this.files')) {
        return { result: { value: this.uploadedFileNames } };
      }

      if (fn.includes('this.innerText || this.textContent')) {
        return { result: { value: this.triggerDisplayText } };
      }

      return { result: { value: undefined } };
    }

    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes("probe: 'dom_summary'")) {
        return {
          result: {
            value: {
              probe: 'dom_summary',
              url: this.url,
              title: this.title,
              formsCount: 1,
              requiredFieldsCount: 5,
              emptyRequiredLabels: ['入学时间'],
              sectionHeadings: ['基本信息', '教育经历'],
              fileInputsCount: 1,
              iframesCount: 0,
            },
          },
        };
      }
      if (expr.includes("probe: 'form_errors'")) {
        return {
          result: {
            value: {
              probe: 'form_errors',
              errorCount: 1,
              errors: ['请选择入学时间'],
            },
          },
        };
      }
      if (expr.includes("probe: 'custom_control_state'")) {
        return {
          result: {
            value: {
              probe: 'custom_control_state',
              activeElementTag: 'DIV',
              openPopupsCount: 1,
              visibleOptions: ['广东省', '浙江省', '北京市'],
            },
          },
        };
      }
      if (expr.includes('input[type="search"]')) {
        return {
          result: {
            value: {
              found: true,
              metadata: {
                tagName: 'INPUT',
                inputType: 'search',
                accessibleLabel: '搜索选项',
                fieldIdentityText: 'search-city',
                inForm: true,
              },
            },
          },
        };
      }
      if (expr.includes('.ant-cascader-menu-item')) {
        const matched = expr.match(/\)\((.+)\)$/);
        const target = matched ? (JSON.parse(matched[1]!) as string) : '';
        if (this.simulateSubmitOption) {
          return {
            result: {
              value: {
                found: true,
                x: 250,
                y: 260,
                matchedText: target,
                metadata: {
                  tagName: 'BUTTON',
                  buttonType: 'submit',
                  accessibleLabel: '确认提交',
                  inForm: true,
                  inCrossOriginIframe: false,
                },
              },
            },
          };
        }
        this.triggerDisplayText =
          this.triggerDisplayText === '请选择' ? target : `${this.triggerDisplayText} / ${target}`;
        return {
          result: {
            value: {
              found: true,
              x: 220,
              y: 240,
              matchedText: target,
              metadata: {
                tagName: 'LI',
                accessibleLabel: target,
                inForm: true,
                inCrossOriginIframe: false,
              },
            },
          },
        };
      }
      return { result: { value: {} } };
    }

    return {};
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

describe('@jobhelper/browser-bridge M6 complex controls, multi-upload & read-only probes', () => {
  it('supports searchable & multi-level cascade choose_option while blocking submit-like options', async () => {
    const mockViews: ComplexControlMockView[] = [];
    const factory: WebContentsViewFactory = {
      createView: ({ initialBounds }) => {
        const v = new ComplexControlMockView(`t-${mockViews.length + 1}`, initialBounds);
        mockViews.push(v);
        return v;
      },
    };
    const controls = new TaskControls();
    const tabs = new LocalTaskTabManager({ viewFactory: factory });
    const guard = new DefaultSubmitHardGuard({ mode: 'manual_only' });
    const controller = new ScopedBrowserController({
      tabs,
      assertActive: (t, e) => controls.assert(t, e),
      submitGuard: guard,
      resolveAuthorizedFilePath: (_taskId, materialId) => ({
        filePath: `C:\\mock\\materials\\${materialId}\\${materialId === 'mat-1' ? 'Resume.pdf' : 'Transcript.pdf'}`,
        fileName: materialId === 'mat-1' ? 'Resume.pdf' : 'Transcript.pdf',
      }),
    });

    const taskId = 'task-m6-1' as TaskId;
    const epoch = controls.acquire(taskId);
    await tabs.createTab(taskId, 'https://app.mokahr.com/campus/apply/demo', 'default' as BrowserProfileId);

    // 1. Multi-level cascade + searchQuery
    const snap1 = await controller.observe(taskId, epoch);
    const cityRef = snap1.nodes.find((n) => n.name === '期望工作地')?.ref!;
    const cascadeRes = await controller.act({
      taskId,
      epoch,
      action: 'choose_option',
      ref: cityRef,
      searchQuery: '深圳',
      optionPath: ['广东省', '深圳市', '南山区'],
    });
    expect(cascadeRes.ok).toBe(true);
    expect(cascadeRes.readbackValue).toContain('广东省 / 深圳市 / 南山区');
    expect(mockViews[0]?.insertedSearchTexts).toEqual(['深圳']);
    // 1 trigger click + 3 cascade option clicks
    expect(mockViews[0]?.clickedCoords).toHaveLength(4);

    // 2. Submit Hard-Guard blocks submit-like optionText via choose_option
    const snap2 = await controller.observe(taskId, epoch);
    const cityRef2 = snap2.nodes.find((n) => n.name === '期望工作地')?.ref!;
    const blockedTextRes = await controller.act({
      taskId,
      epoch,
      action: 'choose_option',
      ref: cityRef2,
      optionText: '提交申请',
    });
    expect(blockedTextRes.ok).toBe(false);
    expect(blockedTextRes.guardBlocked?.matchedRule).toBe('submit_label');

    // 3. Submit Hard-Guard also blocks if matched DOM option element turns out to be a submit button
    const snap3 = await controller.observe(taskId, epoch);
    const cityRef3 = snap3.nodes.find((n) => n.name === '期望工作地')?.ref!;
    mockViews[0]!.simulateSubmitOption = true;
    const blockedOptDomRes = await controller.act({
      taskId,
      epoch,
      action: 'choose_option',
      ref: cityRef3,
      optionText: '下一步',
    });
    expect(blockedOptDomRes.ok).toBe(false);
    expect(blockedOptDomRes.guardBlocked?.matchedRule).toBe('submit_label');
    mockViews[0]!.simulateSubmitOption = false;

    // 4. Multi-file upload verifies all authorized filenames on readback
    const snap4 = await controller.observe(taskId, epoch);
    const uploadRef = snap4.nodes.find((n) => n.name === '上传补充证书')?.ref!;
    const uploadRes = await controller.act({
      taskId,
      epoch,
      action: 'upload',
      ref: uploadRef,
      materialIds: ['mat-1' as MaterialId, 'mat-2' as MaterialId],
    });
    expect(uploadRes.ok).toBe(true);
    expect(uploadRes.readbackValue).toBe('Resume.pdf, Transcript.pdf');
    expect(mockViews[0]?.uploadedPaths).toHaveLength(2);
  });

  it('implements read-only inspectControl (masking passwords, checking guards, preserving refs) and controlled probes', async () => {
    const factory: WebContentsViewFactory = {
      createView: ({ initialBounds }) => new ComplexControlMockView('t-inspect', initialBounds),
    };
    const controls = new TaskControls();
    const tabs = new LocalTaskTabManager({ viewFactory: factory });
    const guard = new DefaultSubmitHardGuard({ mode: 'manual_only' });
    const controller = new ScopedBrowserController({
      tabs,
      assertActive: (t, e) => controls.assert(t, e),
      submitGuard: guard,
    });

    const taskId = 'task-m6-2' as TaskId;
    const epoch = controls.acquire(taskId);
    await tabs.createTab(taskId, 'https://app.mokahr.com/campus/apply/demo', 'default' as BrowserProfileId);

    const snap = await controller.observe(taskId, epoch);
    const dateRef = snap.nodes.find((n) => n.name === '入学时间')?.ref!;
    const passRef = snap.nodes.find((n) => n.name === '登录密码')?.ref!;
    const submitRef = snap.nodes.find((n) => n.name === '提交申请')?.ref!;

    const dateInfo = await controller.inspectControl(taskId, epoch, dateRef);
    expect(dateInfo.readOnly).toBe(true);
    expect(dateInfo.placeholder).toBe('YYYY-MM');
    expect(dateInfo.clickGuard.allowed).toBe(true);

    // Refs stay valid after read-only inspectControl
    const passInfo = await controller.inspectControl(taskId, epoch, passRef);
    expect(passInfo.masked).toBe(true);
    expect(passInfo.value).toBe('[密码]');
    expect(passInfo.fillGuard.allowed).toBe(false);
    expect(passInfo.fillGuard.matchedRule).toBe('password_or_captcha_field');

    const submitInfo = await controller.inspectControl(taskId, epoch, submitRef);
    expect(submitInfo.clickGuard.allowed).toBe(false);
    expect(submitInfo.clickGuard.matchedRule).toBe('submit_label');

    // Read-only probes succeed for allowed probes and reject arbitrary script names
    const summary = await controller.runReadOnlyProbe(taskId, epoch, 'dom_summary');
    expect(summary.probe).toBe('dom_summary');
    expect(summary.emptyRequiredLabels).toEqual(['入学时间']);

    const errors = await controller.runReadOnlyProbe(taskId, epoch, 'form_errors');
    expect(errors.errorCount).toBe(1);

    const popupState = await controller.runReadOnlyProbe(taskId, epoch, 'custom_control_state');
    expect(popupState.openPopupsCount).toBe(1);

    await expect(
      controller.runReadOnlyProbe(taskId, epoch, 'document.forms[0].submit()'),
    ).rejects.toThrow(/禁止执行任意页面脚本/);
  });
});
