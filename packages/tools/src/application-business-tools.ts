import crypto from 'node:crypto';
import type {
  ArtifactId,
  ContentHash,
  MaterialId,
  QuestionId,
  QuestionItem,
  ToolDefinition,
  WaitingReason,
} from '@jobhelper/contracts';
import type { ApplicationBusinessPort, BrowserToolsPort } from './ports.js';

/**
 * Creates all application-scoped business & skill tools.
 * Enforces locked profile snapshot reading, authorized material boundaries,
 * attention locking on human handoff, and evidence-backed submission reporting.
 */
export function createApplicationBusinessTools(
  port: ApplicationBusinessPort,
  browserPort?: Pick<BrowserToolsPort, 'captureScreenshot'>,
): ToolDefinition<any, any>[] {
  return [
    {
      name: 'read_profile',
      description: '读取本投递任务创建时锁定的不可变个人档案版本快照及已确认事实。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        if (!ctx.profileVersionId) {
          return { ok: false, error: { code: 'NO_PROFILE', message: '本任务未绑定档案版本快照' } };
        }
        const data = port.getLockedProfile(ctx.profileVersionId);
        if (!data) {
          return { ok: false, error: { code: 'PROFILE_NOT_FOUND', message: '找不到绑定的档案快照' } };
        }
        return { ok: true, data };
      },
    },
    {
      name: 'read_material',
      description: '分页读取当前任务已授权附件列表中的纯文本材料。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        required: ['materialId'],
        properties: {
          materialId: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      execute: async (input: { materialId: string; offset?: number; limit?: number }, ctx) => {
        const res = await port.readAuthorizedMaterial(
          input.materialId as MaterialId,
          ctx.authorizedMaterialIds,
          input.offset,
          input.limit,
        );
        return { ok: true, data: res };
      },
    },
    {
      name: 'ask_user_question',
      description: '遇到档案缺失的真实事实时向用户发起结构化问题卡（禁止捏造资料）。超时将保持待答状态。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: { type: 'array' },
        },
      },
      execute: async (
        input: {
          questions: Array<{
            id?: string;
            prompt: string;
            options?: string[];
            allowFreeText?: boolean;
            saveToProfileDefault?: boolean;
          }>;
        },
        ctx,
      ) => {
        const normalized: QuestionItem[] = input.questions.map((q) => ({
          id: (q.id || crypto.randomUUID()) as QuestionId,
          prompt: q.prompt,
          options: q.options,
          allowFreeText: q.allowFreeText ?? true,
          saveToProfileDefault: q.saveToProfileDefault ?? true,
        }));
        const res = await port.askUserQuestion({
          taskId: ctx.taskId,
          runId: ctx.runId,
          callId: ctx.callId,
          questions: normalized,
        });
        return {
          ok: true,
          data: res,
          locksAttention: res.status === 'pending',
        };
      },
    },
    {
      name: 'request_user_action',
      description: '遇到登录、验证码或需人工介入时登记结构化待办并立即交还浏览器控制权。调用后必须结束本轮。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['reason', 'summary', 'instructions'],
        properties: {
          reason: {
            type: 'string',
            enum: ['login', 'captcha', 'missing_info', 'manual_control', 'result_check'],
          },
          summary: { type: 'string' },
          instructions: { type: 'string' },
        },
      },
      execute: async (input: { reason: WaitingReason; summary: string; instructions: string }, ctx) => {
        const res = await port.requestUserAction({
          taskId: ctx.taskId,
          runId: ctx.runId,
          reason: input.reason,
          summary: input.summary,
          instructions: input.instructions,
        });
        return { ok: true, data: res, locksAttention: true };
      },
    },
    {
      name: 'capture_confirmation_screenshot',
      description: '为核对卡采集当前页面填写状态截图作为用户核对证据。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string' },
          fullPage: { type: 'boolean' },
        },
      },
      execute: async (input: { label: string; fullPage?: boolean }, ctx) => {
        if (!browserPort) {
          return { ok: false, error: { code: 'NO_BROWSER', message: '截图端口不可用' } };
        }
        const shot = await browserPort.captureScreenshot(ctx.taskId, ctx.epoch, {
          fullPage: input.fullPage,
          label: input.label,
        });
        return { ok: true, data: shot, imageArtifactIds: [shot.artifactId] };
      },
    },
    {
      name: 'report_filling_ready',
      description: '记录主要表单内容已填写并回读核对完毕（推进阶段至 filling_ready，不代表已提交）。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['filledSummary'],
        properties: {
          filledSummary: { type: 'string' },
          missingItems: { type: 'array' },
          attachmentIds: { type: 'array' },
        },
      },
      execute: async (
        input: { filledSummary: string; missingItems?: string[]; attachmentIds?: string[] },
        ctx,
      ) => {
        await port.reportFillingReady({
          taskId: ctx.taskId,
          filledSummary: input.filledSummary,
          missingItems: input.missingItems ?? [],
          attachmentIds: (input.attachmentIds ?? []) as MaterialId[],
        });
        return { ok: true, data: { recorded: true, stage: 'filling_ready' } };
      },
    },
    {
      name: 'request_submission_confirmation',
      description:
        '展示最终核对卡（岗位、关键字段、缺失项、附件与截图）并引导用户在右侧真实网页确认提交。调用后必须结束本轮。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['keyFields', 'contentHash'],
        properties: {
          company: { type: 'string' },
          jobTitle: { type: 'string' },
          keyFields: { type: 'array' },
          missingItems: { type: 'array' },
          attachmentIds: { type: 'array' },
          screenshotArtifactIds: { type: 'array' },
          contentHash: { type: 'string' },
          instructions: { type: 'string' },
        },
      },
      execute: async (
        input: {
          company?: string;
          jobTitle?: string;
          keyFields: Array<{ label: string; value: string }>;
          missingItems?: string[];
          attachmentIds?: string[];
          screenshotArtifactIds?: string[];
          contentHash: string;
          instructions?: string;
        },
        ctx,
      ) => {
        const res = await port.requestSubmissionConfirmation({
          taskId: ctx.taskId,
          runId: ctx.runId,
          company: input.company,
          jobTitle: input.jobTitle,
          keyFields: input.keyFields,
          missingItems: input.missingItems ?? [],
          attachmentIds: (input.attachmentIds ?? []) as MaterialId[],
          screenshotArtifactIds: (input.screenshotArtifactIds ?? []) as ArtifactId[],
          contentHash: input.contentHash as ContentHash,
          instructions: input.instructions,
        });
        return { ok: true, data: res, locksAttention: true };
      },
    },
    {
      name: 'request_manual_submission',
      description: '引导用户在右侧网页手动完成最终提交。调用后结束本轮，等待用户提交并核验回执。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['summary', 'instructions'],
        properties: {
          summary: { type: 'string' },
          instructions: { type: 'string' },
        },
      },
      execute: async (input: { summary: string; instructions: string }, ctx) => {
        const res = await port.requestUserAction({
          taskId: ctx.taskId,
          runId: ctx.runId,
          reason: 'manual_submit',
          summary: input.summary,
          instructions: input.instructions,
        });
        return { ok: true, data: res, locksAttention: true };
      },
    },
    {
      name: 'request_operation_confirmation',
      description: '针对保存草稿或不可逆中间步骤请求本次确认，与最终提交分开。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['operation', 'summary', 'contentHash'],
        properties: {
          operation: { type: 'string', enum: ['save_draft', 'irreversible_step'] },
          summary: { type: 'string' },
          contentHash: { type: 'string' },
        },
      },
      execute: async (
        input: { operation: 'save_draft' | 'irreversible_step'; summary: string; contentHash: string },
        ctx,
      ) => {
        const res = await port.requestOperationConfirmation({
          taskId: ctx.taskId,
          runId: ctx.runId,
          operation: input.operation,
          summary: input.summary,
          contentHash: input.contentHash as ContentHash,
        });
        return { ok: true, data: res, locksAttention: true };
      },
    },
    {
      name: 'report_submit_attempted',
      description: '记录提交动作已经发生（阶段推进至 submit_attempted，结果置为 unknown 以防重复投递）。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['source', 'evidenceNote'],
        properties: {
          source: { type: 'string', enum: ['user_manual', 'authorized_click'] },
          evidenceNote: { type: 'string' },
        },
      },
      execute: async (
        input: { source: 'user_manual' | 'authorized_click'; evidenceNote: string },
        ctx,
      ) => {
        await port.reportSubmitAttempted({
          taskId: ctx.taskId,
          source: input.source,
          evidenceNote: input.evidenceNote,
        });
        return { ok: true, data: { recorded: true, stage: 'submit_attempted', outcome: 'unknown' } };
      },
    },
    {
      name: 'report_submission_result',
      description: '根据招聘官网真实回执上报投递核验结果；无确凿回执时必须传 verified=false 保持待核验。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['verified'],
        properties: {
          verified: { type: 'boolean' },
          receiptText: { type: 'string' },
          receiptUrl: { type: 'string' },
          screenshotArtifactId: { type: 'string' },
        },
      },
      execute: async (
        input: {
          verified: boolean;
          receiptText?: string;
          receiptUrl?: string;
          screenshotArtifactId?: string;
        },
        ctx,
      ) => {
        if (input.verified && !input.receiptText?.trim()) {
          return {
            ok: false,
            error: {
              code: 'MISSING_RECEIPT_EVIDENCE',
              message: '声明官网投递成功 (verified=true) 时必须附带真实页面回执摘要 receiptText',
            },
          };
        }
        const res = await port.reportSubmissionResult({
          taskId: ctx.taskId,
          verified: input.verified,
          receiptText: input.receiptText,
          receiptUrl: input.receiptUrl,
          screenshotArtifactId: input.screenshotArtifactId as ArtifactId | undefined,
        });
        return { ok: true, data: res };
      },
    },
    {
      name: 'update_task_details',
      description: '从真实招聘页面读取到准确公司/岗位名称后更新本任务元信息。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: { company: { type: 'string' }, jobTitle: { type: 'string' } },
      },
      execute: async (input: { company?: string; jobTitle?: string }, ctx) => {
        await port.updateTaskDetails({ taskId: ctx.taskId, ...input });
        return { ok: true, data: { updated: true } };
      },
    },
    {
      name: 'remember_user_info',
      description: '保存用户在本任务中明确确认的补充事实（仅保存用户明确告知内容，禁止猜测）。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['key', 'value', 'confirmedByUser'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          confirmedByUser: { type: 'boolean' },
        },
      },
      execute: async (input: { key: string; value: string; confirmedByUser: boolean }, ctx) => {
        if (!input.confirmedByUser) {
          return {
            ok: false,
            error: { code: 'UNCONFIRMED_FACT', message: '仅允许保存用户明确确认过的事实' },
          };
        }
        const res = await port.rememberUserInfo({ taskId: ctx.taskId, ...input });
        return { ok: true, data: res };
      },
    },
    {
      name: 'report_job_unavailable',
      description: '岗位已下架、已截止或已投递过时上报不可投递原因。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['reason', 'evidenceText'],
        properties: { reason: { type: 'string' }, evidenceText: { type: 'string' } },
      },
      execute: async (input: { reason: string; evidenceText: string }, ctx) => {
        await port.reportJobUnavailable({ taskId: ctx.taskId, ...input });
        return { ok: true, data: { recorded: true, outcome: 'job_unavailable' } };
      },
    },
    {
      name: 'search_site_memories',
      description: '按域名检索本地保存的站点填写经验。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        required: ['domain'],
        properties: { domain: { type: 'string' } },
      },
      execute: async (input: { domain: string }) => {
        return { ok: true, data: { memories: port.searchSiteMemories(input.domain) } };
      },
    },
    {
      name: 'save_site_memory',
      description: '将已验证的站点填写经验保存到本地经验库。',
      category: 'business',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['domain', 'title', 'content'],
        properties: {
          domain: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
      },
      execute: async (input: { domain: string; title: string; content: string }) => {
        const memory = port.saveSiteMemory(input);
        return { ok: true, data: { memory } };
      },
    },
    {
      name: 'skill_list',
      description: '列出可用的站点与通用控件 Skills 元数据索引（仅返回摘要，不占用大量上下文）。',
      category: 'skill',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: { domain: { type: 'string' } },
      },
      execute: async (input: { domain?: string }) => {
        return { ok: true, data: { skills: port.listSkills(input) } };
      },
    },
    {
      name: 'skill_load',
      description: '按需读取指定站点或控件 Skill 的正文手册。',
      category: 'skill',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        required: ['skillName'],
        properties: { skillName: { type: 'string' } },
      },
      execute: async (input: { skillName: string }) => {
        const doc = await port.loadSkill(input.skillName);
        if (!doc) {
          return {
            ok: false,
            error: { code: 'SKILL_NOT_FOUND', message: `未找到 Skill: ${input.skillName}` },
          };
        }
        return { ok: true, data: doc };
      },
    },
    {
      name: 'submit_skill_draft',
      description: '提交一条站点 Skill 修订或新增草稿到本地待审列表，需经用户在设置页审阅批准，严禁直接覆盖内置 Skill。',
      category: 'skill',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['skillName', 'diffOrContent'],
        properties: {
          skillName: { type: 'string' },
          diffOrContent: { type: 'string' },
        },
      },
      execute: async (input: { skillName: string; diffOrContent: string }, ctx) => {
        if (!port.submitSkillDraft) {
          return {
            ok: false,
            error: { code: 'DRAFT_UNSUPPORTED', message: '当前环境未启用 Skill 草稿存储' },
          };
        }
        const draft = port.submitSkillDraft({
          taskId: ctx.taskId,
          skillName: input.skillName.trim(),
          diffOrContent: input.diffOrContent,
        });
        return { ok: true, data: { draft } };
      },
    },
  ];
}
