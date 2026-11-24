import type {
  BrowserActCommand,
  ConfirmationId,
  SubmitGuardDecision,
  SubmitGuardMode,
  TaskId,
} from '@jobhelper/contracts';
import type { SubmitHardGuard } from './bridge.js';

const FINAL_SUBMIT_LABEL_REGEX =
  /提交申请|确认投递|立即投递|发送申请|确认提交|最终提交|完成投递|一键投递|投递简历|submit(\s+application)?|send\s+application|apply\s+now|confirm\s+submission|^提交$/i;

const SENSITIVE_FIELD_REGEX =
  /密码|验证码|短信码|图形码|动态码|一次性|password|passwd|pwd|otp|captcha|verification.?code|sms.?code|auth.?code/i;

const ALLOWED_READONLY_PROBES = new Set([
  'dom_summary',
  'form_errors',
  'custom_control_state',
]);

export interface SubmitHardGuardOptions {
  mode?: SubmitGuardMode;
  /** Optional confirmation validator used only when mode === 'confirmation_required'. */
  verifyConfirmation?: (taskId: TaskId, confirmationId: ConfirmationId) => boolean;
}

export interface TargetElementMetadata {
  tagName?: string;
  inputType?: string;
  buttonType?: string;
  accessibleLabel?: string;
  inForm?: boolean;
  inCrossOriginIframe?: boolean;
  fieldIdentityText?: string;
}

/**
 * Unified execution-layer Submit Hard-Guard (ADR-0004).
 * Covers click (ref & coordinates), Enter key, sensitive password/captcha inputs,
 * cross-origin iframes, and arbitrary script evaluation.
 */
export class DefaultSubmitHardGuard implements SubmitHardGuard {
  readonly mode: SubmitGuardMode;
  private readonly verifyConfirmation?: SubmitHardGuardOptions['verifyConfirmation'];

  constructor(options?: SubmitHardGuardOptions) {
    this.mode = options?.mode ?? 'manual_only';
    this.verifyConfirmation = options?.verifyConfirmation;
  }

  evaluateScriptProbe(probeName: string): SubmitGuardDecision {
    if (!ALLOWED_READONLY_PROBES.has(probeName)) {
      return {
        allowed: false,
        matchedRule: 'disallowed_script',
        reason: `v1 禁止执行任意页面脚本 (${probeName})，仅允许受控只读探针`,
      };
    }
    return { allowed: true };
  }

  evaluateRawJsExpression(): SubmitGuardDecision {
    return {
      allowed: false,
      matchedRule: 'disallowed_script',
      reason: 'v1 禁止通过任意 JavaScript 绕过浏览器执行层提交闸门',
    };
  }

  evaluateCommand(
    command: BrowserActCommand,
    targetMetadata?: TargetElementMetadata,
  ): SubmitGuardDecision {
    // 1. Block sensitive password / OTP / captcha autofill unconditionally
    if (command.action === 'fill') {
      const inputType = (targetMetadata?.inputType ?? '').toLowerCase();
      const identity = targetMetadata?.fieldIdentityText ?? targetMetadata?.accessibleLabel ?? '';
      if (inputType === 'password' || SENSITIVE_FIELD_REGEX.test(identity)) {
        return {
          allowed: false,
          matchedRule: 'password_or_captcha_field',
          reason: '密码、短信验证码与图形验证码字段禁止自动填写，请交给用户接管处理',
        };
      }
      return { allowed: true };
    }

    // 2. Block Enter key in forms (implicitly submits HTML forms)
    if (command.action === 'press') {
      if ((command.key ?? '').toLowerCase() === 'enter') {
        const inForm = targetMetadata?.inForm ?? true;
        if (inForm) {
          return {
            allowed: false,
            matchedRule: 'form_enter_key',
            reason: '表单内按 Enter 键可能隐式触发提交，已由执行层硬拦截，请交给用户操作',
          };
        }
      }
      return { allowed: true };
    }

    // 3. Click guard (covers both ref-based clicks and coordinate clicks resolved via elementFromPoint)
    if (command.action === 'click') {
      if (targetMetadata?.inCrossOriginIframe) {
        return {
          allowed: false,
          matchedRule: 'cross_iframe_click',
          reason: '跨 iframe 点击无法安全校验目标元素，请由用户接管完成',
        };
      }

      const tag = (targetMetadata?.tagName ?? '').toUpperCase();
      const buttonType = (targetMetadata?.buttonType ?? '').toLowerCase();
      const inputType = (targetMetadata?.inputType ?? '').toLowerCase();
      const label = (targetMetadata?.accessibleLabel ?? '').trim();

      const isSubmitButtonType =
        (tag === 'BUTTON' && (buttonType === 'submit' || (buttonType === '' && targetMetadata?.inForm))) ||
        (tag === 'INPUT' && inputType === 'submit');
      const isSubmitLabel = label.length > 0 && FINAL_SUBMIT_LABEL_REGEX.test(label);

      if (isSubmitButtonType || isSubmitLabel) {
        if (this.mode === 'manual_only') {
          return {
            allowed: false,
            matchedRule: isSubmitLabel ? 'submit_label' : 'submit_button_type',
            reason: '检测到最终提交动作：首版由用户在核对卡确认后在右侧真实网页亲自提交',
          };
        }

        if (!command.confirmationId || !this.verifyConfirmation?.(command.taskId, command.confirmationId)) {
          return {
            allowed: false,
            matchedRule: 'missing_confirmation',
            reason: '提交操作缺少有效且匹配当前内容版本的用户确认授权卡',
          };
        }
      }
    }

    return { allowed: true };
  }
}
