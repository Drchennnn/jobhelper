import type {
  TaskKind,
  ToolCallContext,
  ToolDefinition,
  ToolExecutionResult,
} from '@jobhelper/contracts';

/**
 * Canonical v1 tool name catalogs (single source of truth shared by Runtime & optional MCP adapter).
 * See docs/TOOL_CONTRACTS.md.
 */
export const COORDINATOR_TOOL_NAMES = [
  'get_career_overview',
  'read_profile',
  'edit_profile',
  'list_materials',
  'read_material',
  'remember_user_info',
  'add_tracked_position',
  'update_progress',
  'start_application',
  'start_applications',
  'application_status',
] as const;

export const APPLICATION_BROWSER_TOOL_NAMES = [
  'observe',
  'candidates',
  'inspect_control',
  'screenshot',
  'act',
  'tabs',
  'network',
  'read_spill',
  'run',
] as const;

export const APPLICATION_BUSINESS_TOOL_NAMES = [
  'read_profile',
  'read_material',
  'ask_user_question',
  'request_user_action',
  'capture_confirmation_screenshot',
  'report_filling_ready',
  'request_submission_confirmation',
  'request_manual_submission',
  'request_operation_confirmation',
  'report_submit_attempted',
  'report_submission_result',
  'update_task_details',
  'remember_user_info',
  'report_job_unavailable',
  'search_site_memories',
  'save_site_memory',
  'skill_list',
  'skill_load',
] as const;

export type CoordinatorToolName = (typeof COORDINATOR_TOOL_NAMES)[number];
export type ApplicationBrowserToolName = (typeof APPLICATION_BROWSER_TOOL_NAMES)[number];
export type ApplicationBusinessToolName = (typeof APPLICATION_BUSINESS_TOOL_NAMES)[number];

/**
 * Single registry enforcing role isolation, schema validation, and attention-lock rejection.
 * Implemented in M3.
 */
export interface UnifiedToolRegistry {
  register(tool: ToolDefinition): void;
  listForRole(role: TaskKind): readonly ToolDefinition[];
  invoke(
    toolName: string,
    rawInput: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolExecutionResult>;
}
