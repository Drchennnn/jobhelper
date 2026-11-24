import type {
  BrowserActCommand,
  BrowserActResult,
  BrowserObservationSnapshot,
  BrowserProfileId,
  ControlInspectionResult,
  Epoch,
  SubmitGuardDecision,
  SubmitGuardMode,
  TabId,
  TaskId,
  TaskTabInfo,
  ViewportRect,
} from '@jobhelper/contracts';

/**
 * Task-scoped CDP bridge contract backed exclusively by owned WebContentsViews.
 * Never opens a Chromium-wide remote debugging port. Implemented in M2.
 */
export interface ScopedCdpBridge {
  /** Issues an ephemeral loopback WebSocket URL bound to (taskId, epoch). */
  issueEndpoint(taskId: TaskId, epoch: Epoch): Promise<string>;
  /** Immediately terminates all CDP routes and peers belonging to taskId. */
  revokeTask(taskId: TaskId): void;
  close(): Promise<void>;
}

export interface TaskTabManager {
  createTab(taskId: TaskId, initialUrl: string, browserProfileId: BrowserProfileId): Promise<TaskTabInfo>;
  listTabs(taskId: TaskId): TaskTabInfo[];
  selectTab(taskId: TaskId, tabId: TabId): void;
  closeTab(taskId: TaskId, tabId: TabId): Promise<void>;
  syncSurfaceBounds(taskId: TaskId | null, visible: boolean, bounds: ViewportRect): void;
}

/**
 * Unified Submit Hard-Guard evaluated on EVERY mutating browser path (click, Enter, point, script).
 * See docs/ADR/0004-submit-hard-guard-in-browser-executor.md.
 */
export interface SubmitHardGuard {
  readonly mode: SubmitGuardMode;
  evaluateCommand(
    command: BrowserActCommand,
    targetMetadata?: {
      tagName?: string;
      inputType?: string;
      buttonType?: string;
      accessibleLabel?: string;
      inForm?: boolean;
      inCrossOriginIframe?: boolean;
      fieldIdentityText?: string;
    },
  ): SubmitGuardDecision;
}

export interface ScopedBrowserExecutor {
  observe(taskId: TaskId, epoch: Epoch, tabId?: TabId): Promise<BrowserObservationSnapshot>;
  act(command: BrowserActCommand): Promise<BrowserActResult>;
  inspectControl?(taskId: TaskId, epoch: Epoch, ref: string, tabId?: TabId): Promise<ControlInspectionResult>;
  runReadOnlyProbe?(
    taskId: TaskId,
    epoch: Epoch,
    probe: string,
    args?: Record<string, unknown>,
    tabId?: TabId,
  ): Promise<Record<string, unknown>>;
  captureScreenshot(
    taskId: TaskId,
    epoch: Epoch,
    options?: { tabId?: TabId; fullPage?: boolean; clip?: ViewportRect },
  ): Promise<{ pngBase64: string; width: number; height: number }>;
}
