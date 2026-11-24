import type {
  MaterialId,
  PositionId,
  PositionProgressStage,
  ProfileContent,
  ProfileId,
  TaskId,
  ToolDefinition,
} from '@jobhelper/contracts';
import type { CoordinatorBusinessPort } from './ports.js';

/**
 * Creates the 11 coordinator-scoped tools.
 * Strictly has NO browser manipulation capability (INV-03).
 */
export function createCoordinatorTools(port: CoordinatorBusinessPort): ToolDefinition<any, any>[] {
  return [
    {
      name: 'get_career_overview',
      description: '获取本地档案列表、当前默认档案、岗位跟踪数量与活跃投递任务概览。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: false,
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, data: port.getCareerOverview() }),
    },
    {
      name: 'read_profile',
      description: '读取指定或当前默认档案的完整结构化内容与个人事实。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: { profileId: { type: 'string' } },
      },
      execute: async (input: { profileId?: string }) => {
        const res = port.readProfile(input.profileId as ProfileId | undefined);
        if (!res) {
          return { ok: false, error: { code: 'PROFILE_NOT_FOUND', message: '未找到可用档案' } };
        }
        return { ok: true, data: res };
      },
    },
    {
      name: 'edit_profile',
      description: '更新指定档案内容并生成新不可变版本快照（不影响已有投递任务锁定版本）。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['profileId', 'nextContent'],
        properties: {
          profileId: { type: 'string' },
          nextContent: { type: 'object' },
          confirmed: { type: 'boolean' },
        },
      },
      execute: async (input: {
        profileId: string;
        nextContent: ProfileContent;
        confirmed?: boolean;
      }) => {
        const res = port.editProfile({
          profileId: input.profileId as ProfileId,
          nextContent: input.nextContent,
          confirmed: input.confirmed,
        });
        return { ok: true, data: res };
      },
    },
    {
      name: 'list_materials',
      description: '列出本地受管理的简历与附件材料清单。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: { profileId: { type: 'string' } },
      },
      execute: async (input: { profileId?: string }) => ({
        ok: true,
        data: { materials: port.listMaterials(input.profileId as ProfileId | undefined) },
      }),
    },
    {
      name: 'read_material',
      description: '分页读取本地素材库中的纯文本材料。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
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
      execute: async (input: { materialId: string; offset?: number; limit?: number }) => {
        const res = await port.readMaterial(
          input.materialId as MaterialId,
          input.offset,
          input.limit,
        );
        return { ok: true, data: res };
      },
    },
    {
      name: 'remember_user_info',
      description: '记录用户明确告知的补充求职事实（如可到岗时间、期望城市）。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['scope', 'key', 'value'],
        properties: {
          scope: { type: 'string', enum: ['global', 'profile'] },
          profileId: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
        },
      },
      execute: async (input: {
        scope: 'global' | 'profile';
        profileId?: string;
        key: string;
        value: string;
      }) => {
        const fact = port.rememberUserInfo({
          scope: input.scope,
          profileId: input.profileId as ProfileId | undefined,
          key: input.key,
          value: input.value,
        });
        return { ok: true, data: { fact } };
      },
    },
    {
      name: 'add_tracked_position',
      description: '按明确来源将岗位添加到本地求职进度表（不捏造链接）。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['company', 'jobTitle', 'applyUrl'],
        properties: {
          company: { type: 'string' },
          jobTitle: { type: 'string' },
          applyUrl: { type: 'string' },
          sourceNote: { type: 'string' },
        },
      },
      execute: async (input: {
        company: string;
        jobTitle: string;
        applyUrl: string;
        sourceNote?: string;
      }) => ({
        ok: true,
        data: { position: port.addTrackedPosition(input) },
      }),
    },
    {
      name: 'update_progress',
      description: '仅按用户明确告知的实际进展更新本地岗位阶段。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['positionId', 'stage'],
        properties: {
          positionId: { type: 'string' },
          stage: {
            type: 'string',
            enum: [
              'saved',
              'in_progress',
              'submitted_verified',
              'submitted_user_reported',
              'assessment',
              'interview',
              'offer',
              'closed',
            ],
          },
          closedReason: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      execute: async (input: {
        positionId: string;
        stage: PositionProgressStage;
        closedReason?: string;
        notes?: string;
      }) => {
        port.updateProgress({
          positionId: input.positionId as PositionId,
          stage: input.stage,
          closedReason: input.closedReason,
          notes: input.notes,
        });
        return { ok: true, data: { updated: true } };
      },
    },
    {
      name: 'start_application',
      description: '为指定岗位创建或复用一个独立投递任务（绑定档案版本，不代表已投递）。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['applyUrl'],
        properties: {
          applyUrl: { type: 'string' },
          positionId: { type: 'string' },
          profileId: { type: 'string' },
          materialIds: { type: 'array' },
          note: { type: 'string' },
        },
      },
      execute: async (
        input: {
          applyUrl: string;
          positionId?: string;
          profileId?: string;
          materialIds?: string[];
          note?: string;
        },
        ctx,
      ) => {
        const res = await port.startApplication({
          applyUrl: input.applyUrl,
          positionId: input.positionId as PositionId | undefined,
          profileId: input.profileId as ProfileId | undefined,
          materialIds: input.materialIds as MaterialId[] | undefined,
          note: input.note,
          originConversationId: ctx.taskId,
        });
        return {
          ok: true,
          data: {
            taskId: res.task.id,
            reused: res.reused,
            executionState: res.task.executionState,
            waitingReason: res.task.waitingReason,
            applicationStage: res.task.applicationStage,
            outcome: res.task.outcome,
          },
        };
      },
    },
    {
      name: 'start_applications',
      description: '批量派发多个独立岗位投递任务，互不串档案与标签页。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['items'],
        properties: { items: { type: 'array' } },
      },
      execute: async (
        input: {
          items: Array<{
            applyUrl: string;
            positionId?: string;
            profileId?: string;
            materialIds?: string[];
            note?: string;
          }>;
        },
        ctx,
      ) => {
        const results = [];
        for (const item of input.items) {
          try {
            const res = await port.startApplication({
              applyUrl: item.applyUrl,
              positionId: item.positionId as PositionId | undefined,
              profileId: item.profileId as ProfileId | undefined,
              materialIds: item.materialIds as MaterialId[] | undefined,
              note: item.note,
              originConversationId: ctx.taskId,
            });
            results.push({ applyUrl: item.applyUrl, taskId: res.task.id, reused: res.reused });
          } catch (error) {
            results.push({
              applyUrl: item.applyUrl,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return { ok: true, data: { results } };
      },
    },
    {
      name: 'application_status',
      description: '查询本地全部或指定投递任务的四轴状态与等待原因。',
      category: 'coordinator',
      allowedRoles: ['coordinator'],
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: { taskIds: { type: 'array' } },
      },
      execute: async (input: { taskIds?: string[] }) => {
        const tasks = port.listApplicationTasks(input.taskIds as TaskId[] | undefined);
        return {
          ok: true,
          data: tasks.map((t) => ({
            taskId: t.id,
            title: t.title,
            company: t.company,
            jobTitle: t.jobTitle,
            executionState: t.executionState,
            waitingReason: t.waitingReason,
            applicationStage: t.applicationStage,
            outcome: t.outcome,
            controlMode: t.controlMode,
          })),
        };
      },
    },
  ];
}
