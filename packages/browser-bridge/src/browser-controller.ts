import type {
  BrowserActCommand,
  BrowserActResult,
  BrowserObservationSnapshot,
  BrowserObserveNode,
  Epoch,
  TabId,
  TaskId,
  ViewportRect,
} from '@jobhelper/contracts';
import type { ScopedBrowserExecutor } from './bridge.js';
import type { DefaultSubmitHardGuard, TargetElementMetadata } from './submit-guard.js';
import type { LocalTaskTabManager } from './tab-manager.js';
import { validateNavigationUrl } from './url-validator.js';
import type { ManagedTab } from './view-types.js';

const INTERACTIVE_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'spinbutton',
  'slider',
  'tab',
  'menuitem',
  'listbox',
  'option',
  'treeitem',
]);

const ALLOWED_KEYS: Record<string, number> = {
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowLeft: 37,
  ArrowRight: 39,
  Backspace: 8,
};

interface TabRefState {
  observation: number;
  generation: number;
  refs: Map<string, { backendDOMNodeId: number; generation: number; metadata?: TargetElementMetadata }>;
  wiredNavigation: boolean;
}

interface RawAxNode {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

export interface ScopedBrowserControllerOptions {
  tabs: LocalTaskTabManager;
  assertActive: (taskId: TaskId, epoch: Epoch) => void;
  submitGuard: DefaultSubmitHardGuard;
  workbenchOrigin?: string;
  /** Resolves an authorized materialId to its verified local disk path for DOM.setFileInputFiles. */
  resolveAuthorizedFilePath?: (
    taskId: TaskId,
    materialId: NonNullable<BrowserActCommand['materialId']>,
  ) => { filePath: string; fileName: string };
}

/**
 * High-level browser executor enforcing:
 * 1. (taskId, epoch) lease fencing before & after every operation
 * 2. AXTree observation with password masking and generation-scoped refs
 * 3. Unified SubmitHardGuard on click, Enter, coordinate click, sensitive fields
 * 4. Mandatory value read-back verification after fill/select mutations
 */
export class ScopedBrowserController implements ScopedBrowserExecutor {
  private readonly tabStates = new Map<TabId, TabRefState>();

  constructor(private readonly options: ScopedBrowserControllerOptions) {}

  private resolveTab(taskId: TaskId, tabId?: TabId): ManagedTab {
    const tabs = this.options.tabs.getManagedTabs(taskId);
    if (tabs.length === 0) {
      throw new Error(`任务当前没有可用的招聘网页标签 (${taskId})`);
    }
    if (tabId) {
      const found = tabs.find((t) => t.id === tabId);
      if (!found) throw new Error(`标签页不属于当前任务: ${tabId}`);
      return found;
    }
    const active = this.options.tabs.getActiveManagedTab(taskId);
    if (!active) throw new Error(`任务没有活动标签页 (${taskId})`);
    return active;
  }

  private getTabState(tab: ManagedTab): TabRefState {
    let state = this.tabStates.get(tab.id);
    if (!state) {
      state = {
        observation: 0,
        generation: 0,
        refs: new Map(),
        wiredNavigation: false,
      };
      this.tabStates.set(tab.id, state);
    }
    if (!state.wiredNavigation && !tab.view.webContents.isDestroyed()) {
      state.wiredNavigation = true;
      const invalidate = () => this.invalidateTab(tab.id);
      tab.view.webContents.on('did-start-navigation', invalidate);
      tab.view.webContents.debugger.on('detach', invalidate);
    }
    return state;
  }

  invalidateTab(tabId: TabId): void {
    const state = this.tabStates.get(tabId);
    if (!state) return;
    state.refs.clear();
    state.generation++;
  }

  private async sendCdp(
    tab: ManagedTab,
    taskId: TaskId,
    epoch: Epoch,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.options.assertActive(taskId, epoch);
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) throw new Error('标签页已关闭');
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    const res = await contents.debugger.sendCommand(method, params);
    this.options.assertActive(taskId, epoch);
    return res;
  }

  async observe(taskId: TaskId, epoch: Epoch, tabId?: TabId): Promise<BrowserObservationSnapshot> {
    this.options.assertActive(taskId, epoch);
    const tab = this.resolveTab(taskId, tabId);
    const state = this.getTabState(tab);

    this.invalidateTab(tab.id);
    const generation = state.generation;
    const axResult = (await this.sendCdp(tab, taskId, epoch, 'Accessibility.getFullAXTree')) as {
      nodes?: RawAxNode[];
    };

    const obsPrefix = ++state.observation;
    const nodes: BrowserObserveNode[] = [];
    let truncated = false;

    for (const raw of axResult.nodes ?? []) {
      if (raw.ignored || !raw.backendDOMNodeId) continue;
      const role = raw.role?.value ?? 'generic';
      const interactive = INTERACTIVE_ROLES.has(role);
      const isProtected =
        role === 'textbox' &&
        Boolean(raw.properties?.some((p) => p.name === 'protected' && Boolean(p.value?.value)));

      let ref: string | undefined;
      if (interactive) {
        ref = `${tab.id}:e${obsPrefix}_${nodes.length + 1}`;
        state.refs.set(ref, {
          backendDOMNodeId: raw.backendDOMNodeId,
          generation,
          metadata: {
            accessibleLabel: raw.name?.value,
            inputType: isProtected ? 'password' : undefined,
            fieldIdentityText: raw.name?.value,
          },
        });
      }

      const propBool = (name: string): boolean | undefined => {
        const found = raw.properties?.find((p) => p.name === name);
        return typeof found?.value?.value === 'boolean' ? found.value.value : undefined;
      };

      nodes.push({
        ref,
        role,
        name: raw.name?.value,
        value: isProtected ? '[密码]' : raw.value?.value,
        masked: isProtected || undefined,
        required: propBool('required'),
        disabled: propBool('disabled'),
        checked: propBool('checked'),
        selected: propBool('selected'),
      });

      if (nodes.length >= 600) {
        truncated = true;
        break;
      }
    }

    if (generation !== state.generation) {
      throw new Error('观察期间页面发生变化，请重新 observe');
    }

    return {
      tabId: tab.id,
      url: tab.view.webContents.getURL() || tab.url,
      title: tab.view.webContents.getTitle(),
      generation,
      nodes,
      truncated,
    };
  }

  async captureScreenshot(
    taskId: TaskId,
    epoch: Epoch,
    options?: { tabId?: TabId; fullPage?: boolean; clip?: ViewportRect },
  ): Promise<{ pngBase64: string; width: number; height: number }> {
    this.options.assertActive(taskId, epoch);
    const tab = this.resolveTab(taskId, options?.tabId);
    const shot = await tab.view.webContents.capturePagePngBase64();
    this.options.assertActive(taskId, epoch);
    return { pngBase64: shot.base64, width: shot.width, height: shot.height };
  }

  async act(command: BrowserActCommand): Promise<BrowserActResult> {
    this.options.assertActive(command.taskId, command.epoch);
    const tab = this.resolveTab(command.taskId, command.tabId);
    const state = this.getTabState(tab);

    if (command.action === 'navigate') {
      if (!command.url) throw new Error('navigate 缺少目标网址');
      const validUrl = validateNavigationUrl(command.url, this.options.workbenchOrigin);
      await tab.view.webContents.loadURL(validUrl);
      this.invalidateTab(tab.id);
      return { ok: true, changed: true, nextHint: '页面已跳转，请重新 observe' };
    }

    if (command.action === 'scroll') {
      const dy = Number(command.dy);
      if (!Number.isFinite(dy) || Math.abs(dy) > 3000) {
        throw new Error('滚动偏移 dy 无效');
      }
      await this.sendCdp(tab, command.taskId, command.epoch, 'Runtime.evaluate', {
        expression: `window.scrollBy({ top: ${dy}, behavior: 'instant' })`,
      });
      this.invalidateTab(tab.id);
      return { ok: true, changed: true, nextHint: '滚动完成，请重新 observe' };
    }

    if (command.action === 'press') {
      const key = command.key ?? '';
      if (!Object.hasOwn(ALLOWED_KEYS, key)) {
        throw new Error(`不支持的按键: ${key}`);
      }
      const focusMeta = await this.inspectActiveElementMetadata(tab, command.taskId, command.epoch);
      const decision = this.options.submitGuard.evaluateCommand(command, focusMeta);
      if (!decision.allowed) {
        return { ok: false, guardBlocked: decision, error: decision.reason };
      }
      const keyParams = { key, code: key, windowsVirtualKeyCode: ALLOWED_KEYS[key] };
      await this.sendCdp(tab, command.taskId, command.epoch, 'Input.dispatchKeyEvent', {
        ...keyParams,
        type: 'keyDown',
      });
      await this.sendCdp(tab, command.taskId, command.epoch, 'Input.dispatchKeyEvent', {
        ...keyParams,
        type: 'keyUp',
      });
      this.invalidateTab(tab.id);
      return { ok: true, changed: true, nextHint: '按键完成，请重新 observe' };
    }

    // Coordinate click: resolve target element via elementFromPoint & enforce SubmitHardGuard
    if (command.action === 'click' && command.point && !command.ref) {
      const { x, y } = command.point;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        throw new Error('点击坐标无效');
      }
      const hitMeta = await this.inspectPointMetadata(tab, command.taskId, command.epoch, x, y);
      const decision = this.options.submitGuard.evaluateCommand(command, hitMeta);
      if (!decision.allowed) {
        return { ok: false, guardBlocked: decision, error: decision.reason };
      }
      await this.dispatchClick(tab, command.taskId, command.epoch, x, y);
      this.invalidateTab(tab.id);
      return { ok: true, changed: true, nextHint: '坐标点击完成，请重新 observe' };
    }

    // Ref-based actions (click, fill, select, check)
    if (!command.ref) {
      throw new Error(`动作 ${command.action} 缺少元素 ref`);
    }
    const refEntry = state.refs.get(command.ref);
    if (!refEntry || refEntry.generation !== state.generation) {
      throw new Error('ref 已失效，请先重新 observe 获取最新页面快照');
    }

    const resolved = (await this.sendCdp(tab, command.taskId, command.epoch, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendDOMNodeId,
      objectGroup: 'jobhelper-action',
    })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error('元素已从页面移除，请重新 observe');
    }

    try {
      const domMeta = await this.inspectObjectMetadata(tab, command.taskId, command.epoch, objectId);
      const mergedMeta: TargetElementMetadata = {
        ...refEntry.metadata,
        ...domMeta,
        accessibleLabel: domMeta.accessibleLabel || refEntry.metadata?.accessibleLabel,
        fieldIdentityText: domMeta.fieldIdentityText || refEntry.metadata?.fieldIdentityText,
      };

      const decision = this.options.submitGuard.evaluateCommand(command, mergedMeta);
      if (!decision.allowed) {
        return { ok: false, guardBlocked: decision, error: decision.reason };
      }

      if (command.action === 'fill') {
        const value = command.value ?? '';
        if (value.length > 20000) throw new Error('填写内容过长');
        await this.callOnObject(
          tab,
          command.taskId,
          command.epoch,
          objectId,
          `function() {
            if (!this.isConnected || this.disabled || this.readOnly) throw new Error('字段不可编辑');
            this.focus();
            if (typeof this.select === 'function') this.select();
          }`,
        );
        await this.sendCdp(tab, command.taskId, command.epoch, 'Input.insertText', { text: value });
        // Mandatory read-back verification
        const readback = (await this.callOnObject(
          tab,
          command.taskId,
          command.epoch,
          objectId,
          'function() { return this.value; }',
        )) as string;
        if (readback !== value) {
          throw new Error(`字段回读不一致: 期望 "${value}"，实际 "${String(readback)}"`);
        }
        return { ok: true, changed: true, readbackValue: readback, nextHint: '填写并回读一致' };
      }

      if (command.action === 'select') {
        const value = command.value ?? '';
        const readback = (await this.callOnObject(
          tab,
          command.taskId,
          command.epoch,
          objectId,
          `function(v) {
            if (this.tagName !== 'SELECT' || this.disabled) throw new Error('不是可编辑原生下拉框');
            const opts = Array.from(this.options || []);
            if (!opts.some(o => o.value === v && !o.disabled)) throw new Error('目标选项不存在');
            this.value = v;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return this.value;
          }`,
          [value],
        )) as string;
        if (readback !== value) {
          throw new Error(`下拉回读不一致: 期望 "${value}"，实际 "${String(readback)}"`);
        }
        return { ok: true, changed: true, readbackValue: readback, nextHint: '下拉选择并回读一致' };
      }

      if (command.action === 'upload') {
        if (!command.materialId || !this.options.resolveAuthorizedFilePath) {
          throw new Error('附件上传缺少已授权的 materialId 或文件路径解析器');
        }
        const { filePath, fileName } = this.options.resolveAuthorizedFilePath(
          command.taskId,
          command.materialId,
        );
        await this.sendCdp(tab, command.taskId, command.epoch, 'DOM.setFileInputFiles', {
          backendNodeId: refEntry.backendDOMNodeId,
          files: [filePath],
        });
        const uploadedName = (await this.callOnObject(
          tab,
          command.taskId,
          command.epoch,
          objectId,
          'function() { return this.files && this.files[0] ? this.files[0].name : ""; }',
        )) as string;
        if (uploadedName && uploadedName !== fileName) {
          throw new Error(`上传文件回读不一致: 期望 "${fileName}"，实际 "${uploadedName}"`);
        }
        return {
          ok: true,
          changed: true,
          readbackValue: uploadedName || fileName,
          nextHint: '附件已选择，请重新 observe 确认页面状态',
        };
      }

      if (command.action === 'click' || command.action === 'check') {
        const pt = (await this.callOnObject(
          tab,
          command.taskId,
          command.epoch,
          objectId,
          `function() {
            if (!this.isConnected || this.disabled) throw new Error('元素不可点击');
            const r = this.getBoundingClientRect();
            if (!r.width || !r.height) throw new Error('元素不可见');
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }`,
        )) as { x: number; y: number };
        await this.dispatchClick(tab, command.taskId, command.epoch, pt.x, pt.y);
        return { ok: true, changed: true, nextHint: '点击完成，请重新 observe' };
      }

      throw new Error(`暂不支持的动作类型: ${command.action}`);
    } finally {
      if (!tab.view.webContents.isDestroyed() && tab.view.webContents.debugger.isAttached()) {
        await tab.view.webContents.debugger
          .sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'jobhelper-action' })
          .catch(() => {});
      }
      this.invalidateTab(tab.id);
    }
  }

  private async dispatchClick(
    tab: ManagedTab,
    taskId: TaskId,
    epoch: Epoch,
    x: number,
    y: number,
  ): Promise<void> {
    await this.sendCdp(tab, taskId, epoch, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      x,
      y,
    });
    await this.sendCdp(tab, taskId, epoch, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      x,
      y,
    });
  }

  private async callOnObject(
    tab: ManagedTab,
    taskId: TaskId,
    epoch: Epoch,
    objectId: string,
    functionDeclaration: string,
    values: unknown[] = [],
  ): Promise<unknown> {
    const res = (await this.sendCdp(tab, taskId, epoch, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: values.map((value) => ({ value })),
      returnByValue: true,
    })) as {
      exceptionDetails?: { exception?: { description?: string } };
      result?: { value?: unknown };
    };
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description?.split('\n')[0] || '页面操作失败');
    }
    return res.result?.value;
  }

  private async inspectObjectMetadata(
    tab: ManagedTab,
    taskId: TaskId,
    epoch: Epoch,
    objectId: string,
  ): Promise<TargetElementMetadata> {
    const meta = (await this.callOnObject(
      tab,
      taskId,
      epoch,
      objectId,
      `function() {
        return {
          tagName: this.tagName,
          inputType: this.type,
          buttonType: this.getAttribute && this.getAttribute('type') || this.type || '',
          accessibleLabel: [this.innerText, this.getAttribute && this.getAttribute('aria-label'), this.value].filter(Boolean).join(' '),
          inForm: Boolean(this.form || (this.closest && this.closest('form'))),
          inCrossOriginIframe: this.ownerDocument && this.ownerDocument.defaultView !== window.top,
          fieldIdentityText: [this.name, this.id, this.placeholder, this.getAttribute && this.getAttribute('autocomplete')].filter(Boolean).join(' ')
        };
      }`,
    )) as TargetElementMetadata | undefined;
    return meta ?? {};
  }

  private async inspectPointMetadata(
    tab: ManagedTab,
    taskId: TaskId,
    epoch: Epoch,
    x: number,
    y: number,
  ): Promise<TargetElementMetadata> {
    const res = (await this.sendCdp(tab, taskId, epoch, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (!el) return {};
        if (el.tagName === 'IFRAME') return { tagName: 'IFRAME', inCrossOriginIframe: true };
        return {
          tagName: el.tagName,
          inputType: el.type,
          buttonType: el.getAttribute('type') || el.type || '',
          accessibleLabel: [el.innerText, el.getAttribute('aria-label'), el.value].filter(Boolean).join(' '),
          inForm: Boolean(el.form || el.closest('form')),
          inCrossOriginIframe: false
        };
      })()`,
      returnByValue: true,
    })) as { result?: { value?: TargetElementMetadata } };
    return res.result?.value ?? {};
  }

  private async inspectActiveElementMetadata(
    tab: ManagedTab,
    taskId: TaskId,
    epoch: Epoch,
  ): Promise<TargetElementMetadata> {
    const res = (await this.sendCdp(tab, taskId, epoch, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.activeElement;
        if (!el) return { inForm: true };
        return {
          tagName: el.tagName,
          inForm: Boolean(el.form || (el.closest && el.closest('form')) || ['INPUT','TEXTAREA','SELECT'].includes(el.tagName))
        };
      })()`,
      returnByValue: true,
    })) as { result?: { value?: TargetElementMetadata } };
    return res.result?.value ?? { inForm: true };
  }
}
