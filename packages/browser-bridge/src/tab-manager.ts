import crypto from 'node:crypto';
import type {
  BrowserProfileId,
  TabId,
  TaskId,
  TaskTabInfo,
  ViewportRect,
} from '@jobhelper/contracts';
import type { TaskTabManager } from './bridge.js';
import { validateNavigationUrl } from './url-validator.js';
import type { ManagedTab, WebContentsViewFactory } from './view-types.js';

const DEFAULT_BACKGROUND_BOUNDS: ViewportRect = { x: 0, y: 0, width: 1280, height: 800 };

export interface TaskTabManagerOptions {
  viewFactory: WebContentsViewFactory;
  workbenchOrigin?: string;
  onTabAdded?: (tab: ManagedTab) => void;
  onTabRemoved?: (tab: ManagedTab) => void;
  onRendererGone?: (taskId: TaskId, tabId: TabId) => void;
}

export function browserPartitionForProfile(browserProfileId: BrowserProfileId): string {
  const safe = browserProfileId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  return `persist:jobhelper-${safe}`;
}

export class LocalTaskTabManager implements TaskTabManager {
  private readonly tabsByTask = new Map<TaskId, ManagedTab[]>();
  private readonly activeTabByTask = new Map<TaskId, TabId>();
  private surfaceState: { taskId: TaskId | null; visible: boolean; bounds: ViewportRect } = {
    taskId: null,
    visible: false,
    bounds: { ...DEFAULT_BACKGROUND_BOUNDS },
  };

  constructor(private readonly options: TaskTabManagerOptions) {}

  async createTab(
    taskId: TaskId,
    initialUrl: string,
    browserProfileId: BrowserProfileId,
  ): Promise<TaskTabInfo> {
    const validUrl = validateNavigationUrl(initialUrl, this.options.workbenchOrigin);
    const tabId = crypto.randomUUID() as TabId;
    const partition = browserPartitionForProfile(browserProfileId);

    const view = this.options.viewFactory.createView({
      partition,
      initialBounds: { ...DEFAULT_BACKGROUND_BOUNDS },
      onWindowOpen: (popupUrl) => {
        // Popups opened by a recruitment site stay inside the SAME taskId & browserProfileId
        void this.createTab(taskId, popupUrl, browserProfileId).catch(() => {});
      },
    });

    const tab: ManagedTab = {
      id: tabId,
      taskId,
      browserProfileId,
      url: validUrl,
      view,
      loading: validUrl !== 'about:blank',
    };

    view.webContents.on('did-navigate', () => {
      tab.url = view.webContents.getURL() || tab.url;
    });
    view.webContents.on('did-stop-loading', () => {
      tab.loading = false;
      tab.url = view.webContents.getURL() || tab.url;
    });
    view.webContents.on('render-process-gone', () => {
      tab.needsReload = true;
      tab.loading = false;
      this.options.onRendererGone?.(taskId, tabId);
    });

    const list = this.tabsByTask.get(taskId) ?? [];
    list.push(tab);
    this.tabsByTask.set(taskId, list);
    this.activeTabByTask.set(taskId, tabId);

    this.applyVisibilityLayout();
    if (validUrl && validUrl !== 'about:blank') {
      await view.webContents.loadURL(validUrl);
      tab.url = view.webContents.getURL() || validUrl;
      tab.loading = false;
    }

    this.options.onTabAdded?.(tab);
    return this.toTabInfo(tab);
  }

  getManagedTabs(taskId: TaskId): ManagedTab[] {
    return (this.tabsByTask.get(taskId) ?? []).filter(
      (tab) => !tab.view.webContents.isDestroyed(),
    );
  }

  getActiveManagedTab(taskId: TaskId): ManagedTab | null {
    const tabs = this.getManagedTabs(taskId);
    if (tabs.length === 0) return null;
    const activeId = this.activeTabByTask.get(taskId);
    return tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  }

  listTabs(taskId: TaskId): TaskTabInfo[] {
    return this.getManagedTabs(taskId).map((t) => this.toTabInfo(t));
  }

  selectTab(taskId: TaskId, tabId: TabId): void {
    const tabs = this.getManagedTabs(taskId);
    const found = tabs.find((t) => t.id === tabId);
    if (!found) {
      throw new Error(`标签页不属于当前任务 (${taskId}): ${tabId}`);
    }
    this.activeTabByTask.set(taskId, tabId);
    this.applyVisibilityLayout();
  }

  async closeTab(taskId: TaskId, tabId: TabId, options?: { allowCloseLast?: boolean }): Promise<void> {
    const tabs = this.getManagedTabs(taskId);
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) {
      throw new Error(`标签页不属于当前任务 (${taskId}): ${tabId}`);
    }
    if (!options?.allowCloseLast && tabs.length <= 1) {
      throw new Error('不能关闭任务的最后一个招聘网页标签页');
    }

    const [removed] = tabs.splice(idx, 1);
    if (tabs.length === 0) {
      this.tabsByTask.delete(taskId);
      this.activeTabByTask.delete(taskId);
    } else {
      this.tabsByTask.set(taskId, tabs);
      if (this.activeTabByTask.get(taskId) === tabId) {
        this.activeTabByTask.set(taskId, tabs[0]!.id);
      }
    }

    if (removed) {
      this.options.onTabRemoved?.(removed);
      removed.view.destroy();
    }
    this.applyVisibilityLayout();
  }

  async closeAllTabsForTask(taskId: TaskId): Promise<void> {
    const tabs = [...this.getManagedTabs(taskId)];
    this.tabsByTask.delete(taskId);
    this.activeTabByTask.delete(taskId);
    for (const tab of tabs) {
      this.options.onTabRemoved?.(tab);
      tab.view.destroy();
    }
  }

  syncSurfaceBounds(taskId: TaskId | null, visible: boolean, bounds: ViewportRect): void {
    this.surfaceState = {
      taskId,
      visible,
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      },
    };
    this.applyVisibilityLayout();
  }

  private applyVisibilityLayout(): void {
    for (const [taskId, tabs] of this.tabsByTask.entries()) {
      const activeId = this.activeTabByTask.get(taskId);
      const isSurfaceTask = this.surfaceState.visible && this.surfaceState.taskId === taskId;
      for (const tab of tabs) {
        if (tab.view.webContents.isDestroyed()) continue;
        if (isSurfaceTask && tab.id === activeId) {
          tab.view.setBounds(this.surfaceState.bounds);
          tab.view.setVisible(true);
        } else {
          // Keep non-zero viewport on background views so hidden layout & CDP capture keep working
          const cur = tab.view.getBounds();
          if (cur.width <= 0 || cur.height <= 0) {
            tab.view.setBounds(DEFAULT_BACKGROUND_BOUNDS);
          }
          tab.view.setVisible(false);
        }
      }
    }
  }

  private toTabInfo(tab: ManagedTab): TaskTabInfo {
    const liveUrl = !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() : '';
    const liveTitle = !tab.view.webContents.isDestroyed() ? tab.view.webContents.getTitle() : '';
    return {
      id: tab.id,
      taskId: tab.taskId,
      url: liveUrl || tab.url,
      title: liveTitle,
      active: this.activeTabByTask.get(tab.taskId) === tab.id,
      loading: tab.loading,
    };
  }
}
