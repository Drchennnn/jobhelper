import type {
  BrowserActionType,
  MaterialId,
  TabId,
  ToolDefinition,
} from '@jobhelper/contracts';
import type { BrowserToolsPort } from './ports.js';

/**
 * Creates the 9 application-scoped browser tools (observe -> inspect_control -> act -> observe).
 * Only allowed for role='application'; never exposed to coordinator.
 */
export function createApplicationBrowserTools(port: BrowserToolsPort): ToolDefinition<any, any>[] {
  return [
    {
      name: 'observe',
      description: '读取当前招聘网页的可访问性树与元素 ref（密码框值已自动脱敏）。每次页面操作后需重新观察。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
        },
      },
      execute: async (input: { tabId?: string }, ctx) => {
        const snap = await port.observe(ctx.taskId, ctx.epoch, input.tabId as TabId | undefined);
        return { ok: true, data: snap };
      },
    },
    {
      name: 'candidates',
      description: '按关键词在最近一次观察结果中筛选候选交互控件。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          role: { type: 'string' },
          limit: { type: 'number' },
          tabId: { type: 'string' },
        },
      },
      execute: async (input: { query: string; role?: string; limit?: number; tabId?: string }, ctx) => {
        const snap = await port.observe(ctx.taskId, ctx.epoch, input.tabId as TabId | undefined);
        const q = input.query.toLowerCase();
        const matches = snap.nodes
          .filter((n) => {
            if (!n.ref) return false;
            if (input.role && n.role !== input.role) return false;
            return `${n.name ?? ''} ${n.value ?? ''} ${n.role}`.toLowerCase().includes(q);
          })
          .slice(0, Math.max(1, Math.min(input.limit ?? 15, 50)));
        return { ok: true, data: { tabId: snap.tabId, generation: snap.generation, matches } };
      },
    },
    {
      name: 'inspect_control',
      description: '检查指定 ref 控件的详细属性、表单归属及是否命中提交闸门。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        required: ['ref'],
        properties: { ref: { type: 'string' } },
      },
      execute: async (input: { ref: string }, ctx) => {
        const detail = await port.inspectControl(ctx.taskId, ctx.epoch, input.ref);
        return { ok: true, data: detail };
      },
    },
    {
      name: 'screenshot',
      description: '截取当前任务所属招聘网页截图，支持视觉模型定位非标准控件。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          fullPage: { type: 'boolean' },
          label: { type: 'string' },
        },
      },
      execute: async (input: { tabId?: string; fullPage?: boolean; label?: string }, ctx) => {
        const shot = await port.captureScreenshot(ctx.taskId, ctx.epoch, {
          tabId: input.tabId as TabId | undefined,
          fullPage: input.fullPage,
          label: input.label,
        });
        return { ok: true, data: shot, imageArtifactIds: [shot.artifactId] };
      },
    },
    {
      name: 'act',
      description:
        '对当前任务招聘网页执行受控操作（click/fill/select/check/scroll/press/upload/navigate）。受 Submit Hard-Guard 保护，禁止自动填写密码/验证码或自动最终提交。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'fill', 'select', 'check', 'scroll', 'press', 'upload', 'navigate'],
          },
          tabId: { type: 'string' },
          ref: { type: 'string' },
          value: { type: 'string' },
          materialId: { type: 'string' },
          key: { type: 'string' },
          dy: { type: 'number' },
          url: { type: 'string' },
          point: { type: 'object' },
        },
      },
      execute: async (
        input: {
          action: BrowserActionType;
          tabId?: string;
          ref?: string;
          value?: string;
          materialId?: string;
          key?: string;
          dy?: number;
          url?: string;
          point?: { x: number; y: number };
        },
        ctx,
      ) => {
        if (input.action === 'upload') {
          if (!input.materialId || !ctx.authorizedMaterialIds.includes(input.materialId as MaterialId)) {
            return {
              ok: false,
              error: {
                code: 'UNAUTHORIZED_MATERIAL',
                message: '上传附件必须使用当前任务已授权的 materialId',
              },
            };
          }
        }
        const res = await port.act({
          taskId: ctx.taskId,
          epoch: ctx.epoch,
          tabId: input.tabId as TabId | undefined,
          action: input.action,
          ref: input.ref,
          value: input.value,
          materialId: input.materialId as MaterialId | undefined,
          key: input.key,
          dy: input.dy,
          url: input.url,
          point: input.point,
        });
        return res.ok
          ? { ok: true, data: res }
          : {
              ok: false,
              data: res,
              error: {
                code: res.guardBlocked ? 'SUBMIT_GUARD_BLOCKED' : 'ACT_FAILED',
                message: res.error ?? '网页操作失败',
              },
            };
      },
    },
    {
      name: 'tabs',
      description: '列出、切换、新建或关闭当前任务所属招聘标签页（禁止关闭最后一个标签）。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: true,
      inputSchema: {
        type: 'object',
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['list', 'select', 'open', 'close'] },
          tabId: { type: 'string' },
          url: { type: 'string' },
        },
      },
      execute: async (input: { op: 'list' | 'select' | 'open' | 'close'; tabId?: string; url?: string }, ctx) => {
        if (input.op === 'list') {
          return { ok: true, data: { tabs: port.listTabs(ctx.taskId) } };
        }
        if (input.op === 'select') {
          if (!input.tabId) throw new Error('select 需要 tabId');
          port.selectTab(ctx.taskId, input.tabId as TabId);
          return { ok: true, data: { tabs: port.listTabs(ctx.taskId) } };
        }
        if (input.op === 'open') {
          if (!input.url) throw new Error('open 需要 url');
          const tab = await port.openTab(ctx.taskId, input.url);
          return { ok: true, data: { tab } };
        }
        if (!input.tabId) throw new Error('close 需要 tabId');
        await port.closeTab(ctx.taskId, input.tabId as TabId);
        return { ok: true, data: { tabs: port.listTabs(ctx.taskId) } };
      },
    },
    {
      name: 'network',
      description: '查看当前任务网页近期网络请求摘要（不含敏感 Cookie/Auth 头），辅助核验提交与错误。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      execute: async (input: { filter?: string; limit?: number }, ctx) => {
        const events = await port.listNetworkEvents(ctx.taskId, input.filter, input.limit);
        return { ok: true, data: { events } };
      },
    },
    {
      name: 'read_spill',
      description: '分片读取被折叠保存的超长页面观察或网络响应内容。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        required: ['spillId'],
        properties: {
          spillId: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      execute: async (input: { spillId: string; offset?: number; limit?: number }) => {
        const slice = await port.readSpill(input.spillId, input.offset, input.limit);
        return { ok: true, data: slice };
      },
    },
    {
      name: 'run',
      description:
        '受控只读页面探针（dom_summary / form_errors / custom_control_state）。v1 禁止执行任意自由 JavaScript 字符串。',
      category: 'browser',
      allowedRoles: ['application'],
      mutating: false,
      inputSchema: {
        type: 'object',
        required: ['probe'],
        properties: {
          probe: {
            type: 'string',
            enum: ['dom_summary', 'form_errors', 'custom_control_state'],
          },
          args: { type: 'object' },
        },
      },
      execute: async (input: { probe: string; args?: Record<string, unknown> }, ctx) => {
        const data = await port.runReadOnlyProbe(ctx.taskId, ctx.epoch, input.probe, input.args);
        return { ok: true, data };
      },
    },
  ];
}
