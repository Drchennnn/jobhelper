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
  | 'choose_option'
  | 'check'
  | 'scroll'
  | 'press'
  | 'upload'
  | 'navigate';

export type ReadOnlyProbeName = 'dom_summary' | 'form_errors' | 'custom_control_state';

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
  /** Target visible option label for custom dropdown/popover controls (`choose_option`). */
  optionText?: string;
  /** Ordered cascade path labels (e.g. ["广东省", "深圳市", "南山区"]) for `choose_option`. */
  optionPath?: string[];
  /** Optional search text typed into a searchable custom dropdown before clicking an option. */
  searchQuery?: string;
  materialId?: MaterialId;
  /** Authorized material IDs for multi-file `<input type="file" multiple>` uploads. */
  materialIds?: MaterialId[];
  key?: string;
  point?: { x: number; y: number };
  dy?: number;
  url?: string;
  /** Optional explicit confirmation token if future authorized-click mode is enabled. */
  confirmationId?: ConfirmationId;
}

export interface ControlInspectionResult {
  ref: string;
  tagName: string;
  role?: string;
  inputType?: string;
  buttonType?: string;
  accessibleLabel?: string;
  value?: string;
  masked?: boolean;
  placeholder?: string;
  readOnly: boolean;
  disabled: boolean;
  required: boolean;
  checked?: boolean;
  multiple?: boolean;
  inForm: boolean;
  inCrossOriginIframe: boolean;
  optionsPreview?: Array<{ value: string; label: string; disabled: boolean }>;
  clickGuard: SubmitGuardDecision;
  fillGuard: SubmitGuardDecision;
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
