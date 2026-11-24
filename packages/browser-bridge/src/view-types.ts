import type { BrowserProfileId, TabId, TaskId, ViewportRect } from '@jobhelper/contracts';

export type DebuggerMessageListener = (
  event: unknown,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => void;

/**
 * Structural subset of Electron's `WebContents['debugger']`.
 */
export interface ManagedDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(
    method: string,
    commandParams?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  on(event: 'message', listener: DebuggerMessageListener): void;
  on(event: 'detach', listener: () => void): void;
  removeListener(event: 'message', listener: DebuggerMessageListener): void;
  removeListener(event: 'detach', listener: () => void): void;
}

/**
 * Structural subset of Electron's `WebContents`.
 */
export interface ManagedWebContents {
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  getUserAgent(): string;
  getZoomFactor(): number;
  loadURL(url: string): Promise<void>;
  executeJavaScript<T = unknown>(code: string): Promise<T>;
  capturePagePngBase64(): Promise<{ base64: string; width: number; height: number }>;
  readonly debugger: ManagedDebugger;
  on(event: 'did-start-navigation' | 'did-navigate' | 'did-stop-loading' | 'render-process-gone', listener: (...args: unknown[]) => void): void;
  removeListener(event: 'did-start-navigation' | 'did-navigate' | 'did-stop-loading' | 'render-process-gone', listener: (...args: unknown[]) => void): void;
}

/**
 * Structural subset of Electron's `WebContentsView`.
 */
export interface ManagedWebContentsView {
  readonly webContents: ManagedWebContents;
  setBounds(bounds: ViewportRect): void;
  getBounds(): ViewportRect;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
  destroy(): void;
}

export interface ManagedTab {
  id: TabId;
  taskId: TaskId;
  browserProfileId: BrowserProfileId;
  url: string;
  view: ManagedWebContentsView;
  cdpTargetId?: string;
  cdpAwaitingPage?: boolean;
  loading: boolean;
  needsReload?: boolean;
}

export interface WebContentsViewFactory {
  createView(options: {
    partition: string;
    initialBounds: ViewportRect;
    onWindowOpen?: (url: string) => void;
  }): ManagedWebContentsView;
}
