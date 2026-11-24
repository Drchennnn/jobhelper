import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Epoch, TabId, TaskId, ViewportRect } from '@jobhelper/contracts';
import type { ScopedCdpBridge } from './bridge.js';
import { validateNavigationUrl } from './url-validator.js';
import type { DebuggerMessageListener, ManagedTab, ManagedWebContents } from './view-types.js';

/** 80 MiB frame cap to prevent base64 multi-attachment uploads from dropping the CDP socket. */
export const SCOPED_CDP_MAX_PAYLOAD = 80 * 1024 * 1024;

interface RouteBinding {
  taskId: TaskId;
  epoch: Epoch;
}

interface SessionEntry {
  tab: ManagedTab;
  nativeSession?: string;
}

interface PeerState {
  ws: WebSocket;
  route: RouteBinding;
  sessions: Map<string, SessionEntry>;
  browserSessions: Set<string>;
  listeners: Map<ManagedWebContents, DebuggerMessageListener>;
  serial: number;
  autoAttach: boolean;
  discover: boolean;
}

export interface LocalScopedCdpBridgeOptions {
  getTabs: (taskId: TaskId) => ManagedTab[];
  assertActive: (taskId: TaskId, epoch: Epoch) => void;
  createTab: (taskId: TaskId, url: string) => Promise<ManagedTab>;
  selectTab: (taskId: TaskId, tabId: TabId) => void;
  closeTab: (taskId: TaskId, tabId: TabId) => Promise<void>;
  getWindowBounds?: () => ViewportRect;
  workbenchOrigin?: string;
}

function isTabLive(tab: ManagedTab): boolean {
  return Boolean(tab.view?.webContents) && !tab.view.webContents.isDestroyed();
}

function isTabOpened(tab: ManagedTab): boolean {
  return isTabLive(tab) && tab.view.webContents.getURL() !== '';
}

/**
 * Task-scoped CDP bridge over ephemeral loopback WebSocket routes.
 * Enforces (taskId, epoch) lease validation on upgrade AND every CDP command.
 * Never opens a Chromium-wide remote debugging port.
 */
export class LocalScopedCdpBridge implements ScopedCdpBridge {
  private readonly routes = new Map<string, RouteBinding>();
  private readonly peers = new Set<PeerState>();
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly listening: Promise<void>;

  constructor(private readonly options: LocalScopedCdpBridgeOptions) {
    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: SCOPED_CDP_MAX_PAYLOAD,
    });

    this.server.on('upgrade', (req, socket, head) => {
      const route = req.url ? this.routes.get(req.url) : undefined;
      try {
        if (!route) throw new Error('Invalid CDP route');
        this.options.assertActive(route.taskId, route.epoch);
      } catch {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnect(ws, route));
    });

    this.listening = new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }

  async issueEndpoint(taskId: TaskId, epoch: Epoch): Promise<string> {
    await this.listening;
    this.options.assertActive(taskId, epoch);
    const token = '/' + crypto.randomBytes(32).toString('base64url');
    this.routes.set(token, { taskId, epoch });
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('ScopedCdpBridge failed to bind loopback port');
    }
    return `ws://127.0.0.1:${addr.port}${token}`;
  }

  revokeTask(taskId: TaskId): void {
    for (const [token, route] of this.routes.entries()) {
      if (route.taskId === taskId) {
        this.routes.delete(token);
      }
    }
    for (const peer of this.peers) {
      if (peer.route.taskId === taskId) {
        peer.ws.close(1000, 'task_lease_revoked');
      }
    }
  }

  async notifyTabAdded(tab: ManagedTab): Promise<void> {
    if (!isTabOpened(tab)) {
      this.announceWhenOpened(tab);
      return;
    }
    await this.prepareTab(tab);
    for (const peer of this.peers) {
      if (peer.route.taskId !== tab.taskId) continue;
      try {
        this.options.assertActive(peer.route.taskId, peer.route.epoch);
        if (peer.discover) {
          this.send(peer, {
            method: 'Target.targetCreated',
            params: { targetInfo: this.targetInfo(tab) },
          });
        }
        if (peer.autoAttach) {
          await this.attachTab(peer, tab);
        }
      } catch {
        peer.ws.close();
      }
    }
  }

  notifyTabRemoved(tab: ManagedTab): void {
    if (!tab.cdpTargetId) return;
    for (const peer of this.peers) {
      if (peer.route.taskId !== tab.taskId) continue;
      for (const [sessionId, entry] of peer.sessions.entries()) {
        if (entry.tab === tab) {
          this.send(peer, {
            method: 'Target.detachedFromTarget',
            params: { sessionId, targetId: tab.cdpTargetId },
          });
          peer.sessions.delete(sessionId);
        }
      }
      this.send(peer, {
        method: 'Target.targetDestroyed',
        params: { targetId: tab.cdpTargetId },
      });
    }
  }

  async close(): Promise<void> {
    for (const peer of this.peers) {
      peer.ws.terminate();
    }
    this.peers.clear();
    this.routes.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private announceWhenOpened(tab: ManagedTab): void {
    if (tab.cdpAwaitingPage || !isTabLive(tab)) return;
    tab.cdpAwaitingPage = true;
    const contents = tab.view.webContents;
    const settle = () => {
      if (!isTabLive(tab)) {
        contents.removeListener('did-navigate', settle);
        contents.removeListener('did-stop-loading', settle);
        return;
      }
      if (!isTabOpened(tab)) return;
      contents.removeListener('did-navigate', settle);
      contents.removeListener('did-stop-loading', settle);
      tab.cdpAwaitingPage = false;
      void this.notifyTabAdded(tab).catch(() => {});
    };
    contents.on('did-navigate', settle);
    contents.on('did-stop-loading', settle);
  }

  private handleConnect(ws: WebSocket, route: RouteBinding): void {
    const peer: PeerState = {
      ws,
      route,
      sessions: new Map(),
      browserSessions: new Set(),
      listeners: new Map(),
      serial: 0,
      autoAttach: false,
      discover: false,
    };
    this.peers.add(peer);

    ws.on('close', () => {
      this.peers.delete(peer);
      for (const [contents, listener] of peer.listeners.entries()) {
        if (!contents.isDestroyed()) {
          contents.debugger.removeListener('message', listener);
          const stillUsed = [...this.peers].some((other) => other.listeners.has(contents));
          if (!stillUsed && contents.debugger.isAttached()) {
            contents.debugger.detach();
          }
        }
      }
    });

    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        ws.close();
        return;
      }
      void this.receive(peer, msg);
    });
  }

  private send(peer: PeerState, payload: Record<string, unknown>): void {
    if (peer.ws.readyState === 1) {
      peer.ws.send(JSON.stringify(payload));
    }
  }

  private ownedOpenedTabs(peer: PeerState): ManagedTab[] {
    return this.options.getTabs(peer.route.taskId).filter(isTabOpened);
  }

  private async prepareTab(tab: ManagedTab): Promise<void> {
    const contents = tab.view.webContents;
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
    }
    if (!tab.cdpTargetId) {
      const info = (await contents.debugger.sendCommand('Target.getTargetInfo')) as {
        targetInfo?: { targetId?: string };
      };
      tab.cdpTargetId = info.targetInfo?.targetId ?? `target-${tab.id}`;
    }
  }

  private targetInfo(tab: ManagedTab): Record<string, unknown> {
    return {
      targetId: tab.cdpTargetId,
      type: 'page',
      browserContextId: `task-${tab.taskId}`,
      title: tab.view.webContents.getTitle(),
      url: tab.view.webContents.getURL() || tab.url,
      attached: true,
      canAccessOpener: false,
    };
  }

  private async attachTab(peer: PeerState, tab: ManagedTab): Promise<string> {
    await this.prepareTab(tab);
    const id = `page-${tab.id}`;
    if (peer.sessions.has(id)) return id;

    const contents = tab.view.webContents;
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
    }
    peer.sessions.set(id, { tab, nativeSession: undefined });

    const listener: DebuggerMessageListener = (_evt, method, originalParams, nativeSession) => {
      let params = originalParams;
      const sessionId = nativeSession ? `${id}/${nativeSession}` : id;
      if (method === 'Target.attachedToTarget' && typeof originalParams.sessionId === 'string') {
        const child = `${id}/${originalParams.sessionId}`;
        peer.sessions.set(child, { tab, nativeSession: originalParams.sessionId });
        const targetInfoObj =
          originalParams.targetInfo && typeof originalParams.targetInfo === 'object'
            ? { ...(originalParams.targetInfo as Record<string, unknown>), browserContextId: `task-${tab.taskId}` }
            : originalParams.targetInfo;
        params = { ...originalParams, sessionId: child, targetInfo: targetInfoObj };
      } else if (method === 'Target.detachedFromTarget' && typeof originalParams.sessionId === 'string') {
        const child = `${id}/${originalParams.sessionId}`;
        peer.sessions.delete(child);
        params = { ...originalParams, sessionId: child };
      }
      this.send(peer, { method, params, sessionId });
    };

    contents.debugger.on('message', listener);
    peer.listeners.set(contents, listener);
    this.send(peer, {
      method: 'Target.attachedToTarget',
      params: { sessionId: id, targetInfo: this.targetInfo(tab), waitingForDebugger: false },
    });
    return id;
  }

  private async attachTabAgain(peer: PeerState, tab: ManagedTab): Promise<string> {
    await this.attachTab(peer, tab);
    const id = `page-${tab.id}#${++peer.serial}`;
    peer.sessions.set(id, { tab, nativeSession: undefined });
    return id;
  }

  private async receive(
    peer: PeerState,
    message: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string },
  ): Promise<void> {
    const { id, method = '', params = {}, sessionId } = message;
    const isBrowserSession = Boolean(sessionId && peer.browserSessions.has(sessionId));

    try {
      // Check active lease BEFORE dispatching any CDP command
      this.options.assertActive(peer.route.taskId, peer.route.epoch);
      let result: Record<string, unknown> = {};

      if (sessionId && !isBrowserSession) {
        const entry = peer.sessions.get(sessionId);
        if (!entry || entry.tab.taskId !== peer.route.taskId) {
          throw new Error('CDP session 不属于本任务');
        }
        if (method === 'Page.navigate' && typeof params.url === 'string') {
          validateNavigationUrl(params.url, this.options.workbenchOrigin);
        }

        if (method === 'Target.getTargetInfo' && !entry.nativeSession) {
          result = { targetInfo: this.targetInfo(entry.tab) };
        } else if (method === 'Page.bringToFront') {
          this.options.selectTab(peer.route.taskId, entry.tab.id);
          result = {};
        } else if (
          /^(Browser|Target)\./.test(method) &&
          !['Target.setAutoAttach', 'Target.detachFromTarget'].includes(method)
        ) {
          throw new Error('不能通过页面 session 访问其他浏览器目标');
        } else if (method === 'Page.captureScreenshot') {
          const shot = await entry.tab.view.webContents.capturePagePngBase64();
          result = { data: shot.base64 };
        } else {
          result = await entry.tab.view.webContents.debugger.sendCommand(
            method,
            params,
            entry.nativeSession,
          );
        }
      } else {
        const owned = this.ownedOpenedTabs(peer);
        await Promise.all(owned.map((tab) => this.prepareTab(tab)));
        const findOwnedTarget = (): ManagedTab => {
          const tab = owned.find((t) => t.cdpTargetId === params.targetId);
          if (!tab) throw new Error('CDP target 不属于本任务');
          return tab;
        };

        switch (method) {
          case 'Browser.getVersion':
            result = {
              protocolVersion: '1.3',
              product: `JobHelper-Chromium/${process.versions.chrome ?? '130'}`,
              revision: '',
              userAgent: owned[0]?.view.webContents.getUserAgent() ?? '',
              jsVersion: process.versions.v8,
            };
            break;
          case 'Target.getBrowserContexts':
            result = { browserContextIds: [] };
            break;
          case 'Target.getTargets':
            result = { targetInfos: owned.map((tab) => this.targetInfo(tab)) };
            break;
          case 'Target.getTargetInfo':
            result = {
              targetInfo: params.targetId
                ? this.targetInfo(findOwnedTarget())
                : {
                    targetId: 'browser',
                    type: 'browser',
                    title: 'JobHelper task browser',
                    url: '',
                    attached: true,
                    canAccessOpener: false,
                  },
            };
            break;
          case 'Target.setDiscoverTargets':
            peer.discover = Boolean(params.discover);
            if (peer.discover) {
              for (const tab of owned) {
                this.send(peer, {
                  method: 'Target.targetCreated',
                  params: { targetInfo: this.targetInfo(tab) },
                });
              }
            }
            result = {};
            break;
          case 'Target.setAutoAttach':
            peer.autoAttach = Boolean(params.autoAttach);
            if (peer.autoAttach) {
              for (const tab of owned) await this.attachTab(peer, tab);
            }
            result = {};
            break;
          case 'Target.attachToBrowserTarget': {
            const name = `browser-${++peer.serial}`;
            peer.browserSessions.add(name);
            result = { sessionId: name };
            break;
          }
          case 'Target.attachToTarget': {
            const tab = findOwnedTarget();
            result = {
              sessionId: isBrowserSession
                ? await this.attachTabAgain(peer, tab)
                : await this.attachTab(peer, tab),
            };
            break;
          }
          case 'Target.activateTarget':
            this.options.selectTab(peer.route.taskId, findOwnedTarget().id);
            result = {};
            break;
          case 'Target.createTarget': {
            const url = typeof params.url === 'string' ? params.url : 'about:blank';
            const created = await this.options.createTab(peer.route.taskId, url);
            await this.prepareTab(created);
            result = { targetId: created.cdpTargetId };
            break;
          }
          case 'Target.closeTarget': {
            const tab = findOwnedTarget();
            await this.options.closeTab(peer.route.taskId, tab.id);
            result = { success: true };
            break;
          }
          case 'Target.detachFromTarget':
            if (typeof params.sessionId === 'string') {
              peer.sessions.delete(params.sessionId);
            }
            result = {};
            break;
          case 'Browser.setDownloadBehavior':
            result = {};
            break;
          case 'Browser.getWindowForTarget':
            findOwnedTarget();
            result = {
              windowId: 1,
              bounds: this.options.getWindowBounds?.() ?? { x: 0, y: 0, width: 1280, height: 800 },
            };
            break;
          case 'Browser.getWindowBounds':
            result = {
              bounds: this.options.getWindowBounds?.() ?? { x: 0, y: 0, width: 1280, height: 800 },
            };
            break;
          case 'Browser.setWindowBounds':
            throw new Error('窗口尺寸由桌面界面管理');
          case 'Browser.close':
            result = {};
            setImmediate(() => peer.ws.close());
            break;
          default:
            throw new Error(`不支持的浏览器根命令: ${method}`);
        }
      }

      // Re-verify active lease BEFORE returning result
      this.options.assertActive(peer.route.taskId, peer.route.epoch);
      this.send(peer, { id, ...(sessionId ? { sessionId } : {}), result });
    } catch (error) {
      const msgText = error instanceof Error ? error.message : String(error);
      this.send(peer, {
        id,
        ...(sessionId ? { sessionId } : {}),
        error: { code: -32000, message: msgText },
      });
    }
  }
}
