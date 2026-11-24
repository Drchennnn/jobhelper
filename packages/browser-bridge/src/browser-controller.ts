import type {
  BrowserActCommand,
  BrowserActResult,
  BrowserObservationSnapshot,
  BrowserObserveNode,
  ControlInspectionResult,
  Epoch,
  MaterialId,
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
        const ids: MaterialId[] =
          command.materialIds && command.materialIds.length > 0
            ? [...command.materialIds]
            : command.materialId
              ? [command.materialId]
              : [];
        if (ids.length === 0 || !this.options.resolveAuthorizedFilePath) {
          throw new Error('附件上传缺少已授权的 materialId/materialIds 或文件路径解析器');
        }
        const resolvedFiles = ids.map((id) =>
          this.options.resolveAuthorizedFilePath!(command.taskId, id),
        );
        await this.sendCdp(tab, command.taskId, command.epoch, 'DOM.setFileInputFiles', {
          backendNodeId: refEntry.backendDOMNodeId,
          files: resolvedFiles.map((f) => f.filePath),
        });
        const rawUploaded = await this.callOnObject(
          tab,
          command.taskId,
          command.epoch,
          objectId,
          'function() { return Array.from(this.files || []).map(f => f.name); }',
        );
        const uploadedNames = Array.isArray(rawUploaded)
          ? rawUploaded.map((x) => String(x))
          : typeof rawUploaded === 'string' && rawUploaded.length > 0
            ? [rawUploaded]
            : [];
        const expectedNames = resolvedFiles.map((f) => f.fileName);
        if (uploadedNames.length > 0) {
          if (
            uploadedNames.length !== expectedNames.length ||
            expectedNames.some((expected, idx) => uploadedNames[idx] !== expected)
          ) {
            throw new Error(
              `上传文件回读不一致: 期望 "${expectedNames.join(', ')}"，实际 "${uploadedNames.join(', ')}"`,
            );
          }
        }
        return {
          ok: true,
          changed: true,
          readbackValue: (uploadedNames.length > 0 ? uploadedNames : expectedNames).join(', '),
          nextHint: '附件已选择，请重新 observe 确认页面状态',
        };
      }

      if (command.action === 'choose_option') {
        const steps = (
          command.optionPath && command.optionPath.length > 0
            ? command.optionPath
            : command.optionText
              ? [command.optionText]
              : []
        )
          .map((s) => s.trim())
          .filter(Boolean);
        if (steps.length === 0) {
          throw new Error('choose_option 缺少 optionText 或 optionPath');
        }

        const triggerPt = (await this.callOnObject(
          tab,
          command.taskId,
          command.epoch,
          objectId,
          `function() {
            if (!this.isConnected || this.disabled) throw new Error('自定义选择器不可点击');
            if (typeof this.scrollIntoView === 'function') this.scrollIntoView({ block: 'center', inline: 'nearest' });
            const r = this.getBoundingClientRect();
            if (!r.width || !r.height) throw new Error('自定义选择器不可见');
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }`,
        )) as { x: number; y: number };
        await this.dispatchClick(tab, command.taskId, command.epoch, triggerPt.x, triggerPt.y);

        if (command.searchQuery && command.searchQuery.trim().length > 0) {
          const searchInfo = await this.focusVisibleSearchInput(tab, command.taskId, command.epoch);
          if (searchInfo.found) {
            const fillDecision = this.options.submitGuard.evaluateCommand(
              { ...command, action: 'fill', value: command.searchQuery },
              searchInfo.metadata,
            );
            if (!fillDecision.allowed) {
              return { ok: false, guardBlocked: fillDecision, error: fillDecision.reason };
            }
            await this.sendCdp(tab, command.taskId, command.epoch, 'Input.insertText', {
              text: command.searchQuery.trim(),
            });
          }
        }

        for (const stepText of steps) {
          const match = await this.findVisibleOptionByText(tab, command.taskId, command.epoch, stepText);
          if (!match.found || match.x === undefined || match.y === undefined) {
            throw new Error(`未找到可见下拉/级联选项: "${stepText}"`);
          }
          const optDecision = this.options.submitGuard.evaluateCommand(
            { ...command, action: 'click', ref: undefined },
            match.metadata,
          );
          if (!optDecision.allowed) {
            return { ok: false, guardBlocked: optDecision, error: optDecision.reason };
          }
          await this.dispatchClick(tab, command.taskId, command.epoch, match.x, match.y);
        }

        const readback = (await this.callOnObject(
          tab,
          command.taskId,
          command.epoch,
          objectId,
          `function() {
            if (typeof this.value === 'string' && this.value.trim()) return this.value.trim();
            return (this.innerText || this.textContent || '').trim();
          }`,
        )) as string | undefined;

        return {
          ok: true,
          changed: true,
          readbackValue: readback || steps.join(' / '),
          nextHint: '自定义选项已选择，请重新 observe 核对联动状态',
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

  async inspectControl(
    taskId: TaskId,
    epoch: Epoch,
    ref: string,
    tabId?: TabId,
  ): Promise<ControlInspectionResult> {
    this.options.assertActive(taskId, epoch);
    const tab = this.resolveTab(taskId, tabId);
    const state = this.getTabState(tab);
    const refEntry = state.refs.get(ref);
    if (!refEntry || refEntry.generation !== state.generation) {
      throw new Error('ref 已失效，请先重新 observe 获取最新页面快照');
    }

    const resolved = (await this.sendCdp(tab, taskId, epoch, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendDOMNodeId,
      objectGroup: 'jobhelper-inspect',
    })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error('元素已从页面移除，请重新 observe');
    }

    try {
      const detail = (await this.callOnObject(
        tab,
        taskId,
        epoch,
        objectId,
        `function() {
          const tag = (this.tagName || '').toUpperCase();
          const inputType = typeof this.type === 'string' ? this.type : '';
          const buttonType = (this.getAttribute && this.getAttribute('type')) || inputType || '';
          const role = (this.getAttribute && this.getAttribute('role')) || '';
          const accessibleLabel = [
            this.getAttribute && this.getAttribute('aria-label'),
            this.innerText,
            this.placeholder,
          ].filter(Boolean).join(' ').trim();
          const fieldIdentityText = [
            this.name,
            this.id,
            this.placeholder,
            this.getAttribute && this.getAttribute('autocomplete'),
          ].filter(Boolean).join(' ').trim();
          const isPassword = inputType.toLowerCase() === 'password';
          const optionsPreview = tag === 'SELECT'
            ? Array.from(this.options || []).slice(0, 30).map(o => ({
                value: String(o.value ?? ''),
                label: String(o.text ?? o.label ?? ''),
                disabled: Boolean(o.disabled),
              }))
            : undefined;
          return {
            tagName: tag,
            role: role || undefined,
            inputType: inputType || undefined,
            buttonType: buttonType || undefined,
            accessibleLabel: accessibleLabel || undefined,
            value: isPassword ? '[密码]' : (typeof this.value === 'string' ? this.value : undefined),
            masked: isPassword || undefined,
            placeholder: typeof this.placeholder === 'string' && this.placeholder ? this.placeholder : undefined,
            readOnly: Boolean(this.readOnly || (this.getAttribute && this.getAttribute('aria-readonly') === 'true')),
            disabled: Boolean(this.disabled || (this.getAttribute && this.getAttribute('aria-disabled') === 'true')),
            required: Boolean(this.required || (this.getAttribute && this.getAttribute('aria-required') === 'true')),
            checked: typeof this.checked === 'boolean' ? this.checked : undefined,
            multiple: typeof this.multiple === 'boolean' ? this.multiple : undefined,
            inForm: Boolean(this.form || (this.closest && this.closest('form'))),
            inCrossOriginIframe: Boolean(this.ownerDocument && this.ownerDocument.defaultView !== window.top),
            fieldIdentityText: fieldIdentityText || undefined,
            optionsPreview,
          };
        }`,
      )) as Omit<ControlInspectionResult, 'ref' | 'clickGuard' | 'fillGuard'> & {
        fieldIdentityText?: string;
      };

      const isMasked = Boolean(detail.masked || refEntry.metadata?.inputType === 'password');
      const mergedMeta: TargetElementMetadata = {
        ...refEntry.metadata,
        tagName: detail.tagName,
        inputType: isMasked ? 'password' : detail.inputType,
        buttonType: detail.buttonType,
        accessibleLabel: detail.accessibleLabel || refEntry.metadata?.accessibleLabel,
        inForm: detail.inForm,
        inCrossOriginIframe: detail.inCrossOriginIframe,
        fieldIdentityText: detail.fieldIdentityText || refEntry.metadata?.fieldIdentityText,
      };

      return {
        ref,
        tagName: detail.tagName,
        role: detail.role,
        inputType: isMasked ? 'password' : detail.inputType,
        buttonType: detail.buttonType,
        accessibleLabel: mergedMeta.accessibleLabel,
        value: isMasked ? '[密码]' : detail.value,
        masked: isMasked || undefined,
        placeholder: detail.placeholder,
        readOnly: detail.readOnly,
        disabled: detail.disabled,
        required: detail.required,
        checked: detail.checked,
        multiple: detail.multiple,
        inForm: detail.inForm,
        inCrossOriginIframe: detail.inCrossOriginIframe,
        optionsPreview: detail.optionsPreview,
        clickGuard: this.options.submitGuard.evaluateCommand(
          { taskId, epoch, action: 'click', ref },
          mergedMeta,
        ),
        fillGuard: this.options.submitGuard.evaluateCommand(
          { taskId, epoch, action: 'fill', ref },
          mergedMeta,
        ),
      };
    } finally {
      if (!tab.view.webContents.isDestroyed() && tab.view.webContents.debugger.isAttached()) {
        await tab.view.webContents.debugger
          .sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'jobhelper-inspect' })
          .catch(() => {});
      }
    }
  }

  async runReadOnlyProbe(
    taskId: TaskId,
    epoch: Epoch,
    probe: string,
    _args?: Record<string, unknown>,
    tabId?: TabId,
  ): Promise<Record<string, unknown>> {
    this.options.assertActive(taskId, epoch);
    const decision = this.options.submitGuard.evaluateScriptProbe(probe);
    if (!decision.allowed) {
      throw new Error(decision.reason ?? `不允许的探针: ${probe}`);
    }
    const tab = this.resolveTab(taskId, tabId);

    const expressions: Record<string, string> = {
      dom_summary: `(() => {
        const requiredEls = Array.from(document.querySelectorAll('[required], [aria-required="true"]'));
        const emptyRequiredLabels = requiredEls
          .filter(el => !el.disabled && ((typeof el.value === 'string' && !el.value.trim()) || (el.type === 'checkbox' && !el.checked)))
          .slice(0, 25)
          .map(el => (el.getAttribute('aria-label') || el.name || el.placeholder || el.id || el.tagName).trim());
        const sectionHeadings = Array.from(document.querySelectorAll('h1, h2, h3, legend, .section-title, .item-section-tpl'))
          .map(el => (el.innerText || '').trim())
          .filter(Boolean)
          .slice(0, 25);
        return {
          probe: 'dom_summary',
          url: location.href,
          title: document.title,
          formsCount: document.forms.length,
          requiredFieldsCount: requiredEls.length,
          emptyRequiredLabels,
          sectionHeadings,
          fileInputsCount: document.querySelectorAll('input[type="file"]').length,
          iframesCount: document.querySelectorAll('iframe').length,
        };
      })()`,
      form_errors: `(() => {
        const selectors = [
          '[aria-invalid="true"]',
          '[role="alert"]',
          '.ant-form-explain',
          '.ant-form-item-explain-error',
          '.formily-item-explain-error',
          '.el-form-item__error',
          '.phoenix-error',
          '.sd-error',
          '.field-error',
          '.error-message',
        ];
        const texts = new Set();
        for (const el of document.querySelectorAll(selectors.join(','))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const t = (el.innerText || el.getAttribute('aria-errormessage') || el.getAttribute('aria-label') || el.name || '').trim();
          if (t) texts.add(t.slice(0, 160));
          if (texts.size >= 30) break;
        }
        const errors = Array.from(texts);
        return { probe: 'form_errors', errorCount: errors.length, errors };
      })()`,
      custom_control_state: `(() => {
        const popupSelectors = [
          '[role="listbox"]',
          '[role="menu"]',
          '[role="dialog"]',
          '.ant-select-dropdown',
          '.ant-cascader-menus',
          '.ant-picker-dropdown',
          '.el-select-dropdown',
          '.phoenix-select-dropdown',
          '.sd-Select-menu',
        ];
        const openPopups = Array.from(document.querySelectorAll(popupSelectors.join(',')))
          .filter(el => {
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          });
        const visibleOptions = [];
        for (const pop of openPopups) {
          for (const opt of pop.querySelectorAll('[role="option"], [role="menuitem"], [role="treeitem"], li, button')) {
            const r = opt.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const text = (opt.innerText || '').trim();
            if (text && !visibleOptions.includes(text)) visibleOptions.push(text.slice(0, 80));
            if (visibleOptions.length >= 40) break;
          }
          if (visibleOptions.length >= 40) break;
        }
        return {
          probe: 'custom_control_state',
          activeElementTag: document.activeElement ? document.activeElement.tagName : null,
          openPopupsCount: openPopups.length,
          visibleOptions,
        };
      })()`,
    };

    const res = (await this.sendCdp(tab, taskId, epoch, 'Runtime.evaluate', {
      expression: expressions[probe],
      returnByValue: true,
    })) as { result?: { value?: Record<string, unknown> } };
    return res.result?.value ?? { probe, ok: true };
  }

  private async focusVisibleSearchInput(
    tab: ManagedTab,
    taskId: TaskId,
    epoch: Epoch,
  ): Promise<{ found: boolean; metadata?: TargetElementMetadata }> {
    const res = (await this.sendCdp(tab, taskId, epoch, 'Runtime.evaluate', {
      expression: `(() => {
        const candidates = [
          document.activeElement,
          ...Array.from(document.querySelectorAll(
            '[role="combobox"] input, [role="listbox"] input, .ant-select-dropdown input, .el-select-dropdown input, .sd-Select input, .phoenix-select input, input[type="search"]'
          )),
        ].filter(Boolean);
        for (const el of candidates) {
          if (el.tagName !== 'INPUT' || el.disabled || el.readOnly) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          el.focus();
          if (typeof el.select === 'function') el.select();
          return {
            found: true,
            metadata: {
              tagName: el.tagName,
              inputType: el.type || 'text',
              accessibleLabel: [el.getAttribute('aria-label'), el.placeholder].filter(Boolean).join(' '),
              fieldIdentityText: [el.name, el.id, el.placeholder, el.getAttribute('autocomplete')].filter(Boolean).join(' '),
              inForm: Boolean(el.form || el.closest('form')),
            },
          };
        }
        return { found: false };
      })()`,
      returnByValue: true,
    })) as { result?: { value?: { found: boolean; metadata?: TargetElementMetadata } } };
    return res.result?.value ?? { found: false };
  }

  private async findVisibleOptionByText(
    tab: ManagedTab,
    taskId: TaskId,
    epoch: Epoch,
    targetText: string,
  ): Promise<{
    found: boolean;
    x?: number;
    y?: number;
    matchedText?: string;
    metadata?: TargetElementMetadata;
  }> {
    const res = (await this.sendCdp(tab, taskId, epoch, 'Runtime.evaluate', {
      expression: `((target) => {
        const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const needle = norm(target).toLowerCase();
        const selectors = [
          '[role="option"]',
          '[role="menuitem"]',
          '[role="treeitem"]',
          '.ant-select-item-option',
          '.ant-cascader-menu-item',
          '.ant-picker-cell-inner',
          '.el-select-dropdown__item',
          '.phoenix-select-option',
          '.sd-Select-option',
          '[role="listbox"] li',
          '[role="menu"] li',
          '.dropdown-option',
          'li',
        ];
        const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
        let partialMatch = null;
        for (const el of nodes) {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (!r.width || !r.height || style.display === 'none' || style.visibility === 'hidden') continue;
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
          const text = norm(el.innerText || el.textContent);
          if (!text) continue;
          const lower = text.toLowerCase();
          const payload = {
            found: true,
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            matchedText: text,
            metadata: {
              tagName: el.tagName,
              inputType: el.type || '',
              buttonType: (el.getAttribute && el.getAttribute('type')) || '',
              accessibleLabel: [el.innerText, el.getAttribute && el.getAttribute('aria-label')].filter(Boolean).join(' '),
              inForm: Boolean(el.form || (el.closest && el.closest('form'))),
              inCrossOriginIframe: Boolean(el.ownerDocument && el.ownerDocument.defaultView !== window.top),
            },
          };
          if (lower === needle) return payload;
          if (!partialMatch && lower.includes(needle)) partialMatch = payload;
        }
        return partialMatch || { found: false };
      })(${JSON.stringify(targetText)})`,
      returnByValue: true,
    })) as {
      result?: {
        value?: {
          found: boolean;
          x?: number;
          y?: number;
          matchedText?: string;
          metadata?: TargetElementMetadata;
        };
      };
    };
    return res.result?.value ?? { found: false };
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
