import type {
  TaskKind,
  ToolCallContext,
  ToolDefinition,
  ToolExecutionResult,
} from '@jobhelper/contracts';

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

export interface UnifiedToolRegistry {
  register(tool: ToolDefinition<any, any>): void;
  get(toolName: string, role?: TaskKind): ToolDefinition<any, any> | undefined;
  listForRole(role: TaskKind): readonly ToolDefinition<any, any>[];
  invoke(
    toolName: string,
    rawInput: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolExecutionResult>;
}

function validateInputSchema(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return '工具入参必须为 JSON 对象';
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const field of required) {
    if (!(field in input) || input[field] === undefined) {
      return `缺少必填参数: ${field}`;
    }
  }

  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, { type?: string; enum?: unknown[] }>)
      : {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const val = input[key];
    if (val === undefined) continue;
    if (propSchema.type) {
      const ok =
        (propSchema.type === 'string' && typeof val === 'string') ||
        (propSchema.type === 'number' && typeof val === 'number' && Number.isFinite(val)) ||
        (propSchema.type === 'boolean' && typeof val === 'boolean') ||
        (propSchema.type === 'array' && Array.isArray(val)) ||
        (propSchema.type === 'object' && val !== null && typeof val === 'object' && !Array.isArray(val));
      if (!ok) {
        return `参数 ${key} 类型不匹配，期望 ${propSchema.type}`;
      }
    }
    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) {
      return `参数 ${key} 不在合法枚举值内: ${String(val)}`;
    }
  }
  return null;
}

/**
 * Single source of truth for tool registration, role isolation, schema validation,
 * and attention-lock enforcement. Shared by built-in AgentRuntime and optional MCP adapter.
 */
export class DefaultToolRegistry implements UnifiedToolRegistry {
  private readonly toolsByRole = new Map<TaskKind, Map<string, ToolDefinition<any, any>>>([
    ['coordinator', new Map()],
    ['application', new Map()],
  ]);
  private readonly allRegisteredNames = new Set<string>();

  register(tool: ToolDefinition<any, any>): void {
    this.allRegisteredNames.add(tool.name);
    for (const role of tool.allowedRoles) {
      this.toolsByRole.get(role)!.set(tool.name, tool);
    }
  }

  registerAll(tools: readonly ToolDefinition<any, any>[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(toolName: string, role?: TaskKind): ToolDefinition<any, any> | undefined {
    if (role) return this.toolsByRole.get(role)?.get(toolName);
    return (
      this.toolsByRole.get('application')?.get(toolName) ??
      this.toolsByRole.get('coordinator')?.get(toolName)
    );
  }

  listForRole(role: TaskKind): readonly ToolDefinition<any, any>[] {
    return [...(this.toolsByRole.get(role)?.values() ?? [])];
  }

  async invoke(
    toolName: string,
    rawInput: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolExecutionResult> {
    if (ctx.signal.aborted) {
      return {
        ok: false,
        error: { code: 'ABORTED', message: '本轮已停止，拒绝继续执行工具调用', retryable: false },
      };
    }

    if (!this.allRegisteredNames.has(toolName)) {
      return {
        ok: false,
        error: { code: 'UNKNOWN_TOOL', message: `未注册的工具: ${toolName}`, retryable: false },
      };
    }

    // INV-03: Strict coordinator vs application role isolation
    const tool = this.toolsByRole.get(ctx.role)?.get(toolName);
    if (!tool) {
      return {
        ok: false,
        error: {
          code: 'ROLE_FORBIDDEN',
          message: `当前角色 (${ctx.role}) 无权调用工具 ${toolName}`,
          retryable: false,
        },
      };
    }

    // Attention lock: once user takeover / confirmation is requested, block further mutations/browser actions
    if (ctx.attentionLocked && (tool.mutating || tool.category === 'browser')) {
      return {
        ok: false,
        error: {
          code: 'ATTENTION_LOCKED',
          message: '本轮已登记人工待办或核对卡，禁止继续操作页面或修改状态，请结束本轮等待用户处理',
          retryable: false,
        },
      };
    }

    const validationError = validateInputSchema(tool.inputSchema, rawInput ?? {});
    if (validationError) {
      return {
        ok: false,
        error: { code: 'INVALID_INPUT', message: validationError, retryable: false },
      };
    }

    try {
      return await tool.execute(rawInput ?? {}, ctx);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }
  }
}
