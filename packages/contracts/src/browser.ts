import type {
  ArtifactId,
  ConfirmationId,
  Epoch,
  MaterialId,
  TabId,
  TaskId,
} from './ids.js';

export type BrowserActionType =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'scroll'
  | 'press'
  | 'upload'
  | 'navigate';

export type SubmitGuardMode = 'manual_only' | 'confirmation_required';

export interface SubmitGuardDecision {
  allowed: boolean;
  reason?: string;
  matchedRule?:
    | 'submit_label'
    | 'submit_button_type'
    | 'form_enter_key'
    | 'cross_iframe_click'
    | 'password_or_captcha_field'
    | 'disallowed_script'
    | 'ambiguous_final_action'
    | 'missing_confirmation';
}

export interface BrowserObserveNode {
  ref?: string;
  role: string;
  name?: string;
  value?: string;
  required?: boolean;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  masked?: boolean;
}

export interface BrowserObservationSnapshot {
  tabId: TabId;
  url: string;
  title: string;
  generation: number;
  nodes: BrowserObserveNode[];
  truncated: boolean;
  spillArtifactId?: ArtifactId;
}

export interface BrowserActCommand {
  taskId: TaskId;
  epoch: Epoch;
  tabId?: TabId;
  action: BrowserActionType;
  ref?: string;
  value?: string;
  materialId?: MaterialId;
  key?: string;
  point?: { x: number; y: number };
  dy?: number;
  url?: string;
  /** Optional explicit confirmation token if future authorized-click mode is enabled. */
  confirmationId?: ConfirmationId;
}

export interface BrowserActResult {
  ok: boolean;
  readbackValue?: string;
  changed?: boolean;
  guardBlocked?: SubmitGuardDecision;
  error?: string;
  nextHint?: string;
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskTabInfo {
  id: TabId;
  taskId: TaskId;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
}
