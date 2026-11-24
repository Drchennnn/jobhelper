import type {
  BrowserProfileId,
  IsoTimestamp,
  MainToRendererEvent,
  MaterialRecord,
  PositionId,
  PositionRecord,
  ProfileId,
  ProfileRecord,
  ProfileVersionId,
  ProfileVersionSnapshot,
  ProviderId,
  ProviderSummaryDto,
  RendererToMainIpc,
  TaskDetailProjection,
  TaskEventRecord,
  TaskId,
  TaskRecord,
  UserFactRecord,
} from '@jobhelper/contracts';

export interface JobHelperBridge extends RendererToMainIpc {
  onMainEvent?: (listener: (event: MainToRendererEvent) => void) => () => void;
  readonly isElectron: boolean;
}

declare global {
  interface Window {
    jobHelper?: RendererToMainIpc & {
      onMainEvent?: (listener: (event: MainToRendererEvent) => void) => () => void;
    };
  }
}

/**
 * In-memory preview bridge used ONLY when opening apps/workbench directly in a regular browser
 * outside Electron (e.g. `vite dev` UI inspection or component tests).
 */
export function createBrowserPreviewBridge(): JobHelperBridge {
  const now = new Date().toISOString() as IsoTimestamp;
  const listeners = new Set<(ev: MainToRendererEvent) => void>();
  const emit = (ev: MainToRendererEvent) => {
    for (const fn of listeners) fn(ev);
  };

  const defaultProfileId = 'preview-prof-1' as ProfileId;
  const defaultVersionId = 'preview-ver-1' as ProfileVersionId;
  const coordId = 'preview-coord-1' as TaskId;

  const profiles = new Map<ProfileId, ProfileRecord>([
    [
      defaultProfileId,
      {
        id: defaultProfileId,
        name: '前端/全栈校招简历（预览示例）',
        activeVersionId: defaultVersionId,
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]);
  const versions = new Map<ProfileVersionId, ProfileVersionSnapshot>([
    [
      defaultVersionId,
      {
        id: defaultVersionId,
        profileId: defaultProfileId,
        versionNumber: 1,
        content: {
          basic: {
            fullName: '林星河',
            phone: '13800138000',
            email: 'lin@example.com',
            city: '上海',
          },
          education: [
            {
              school: '复旦大学',
              degree: '硕士',
              major: '计算机技术',
              startDate: '2024-09',
              endDate: '2027-06',
              gpa: '3.85/4.0',
            },
          ],
          internships: [],
          projects: [],
          skills: ['TypeScript', 'React', 'Node.js', 'Electron'],
        },
        contentHash: 'preview-hash-v1' as never,
        createdAt: now,
      },
    ],
  ]);
  const materials: MaterialRecord[] = [];
  const facts: UserFactRecord[] = [];
  const positions: PositionRecord[] = [];
  const providers: ProviderSummaryDto[] = [];
  const tasks = new Map<TaskId, TaskRecord>([
    [
      coordId,
      {
        id: coordId,
        kind: 'coordinator',
        title: 'JobHelper 求职总助手',
        browserProfileId: 'default' as BrowserProfileId,
        controlMode: 'human',
        executionState: 'draft',
        waitingReason: 'none',
        applicationStage: 'created',
        outcome: 'not_submitted',
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]);
  const eventsByTask = new Map<TaskId, TaskEventRecord[]>();
  let defaultProfile: ProfileId | null = defaultProfileId;
  let maxConcurrent = 3;
  let externalSkillDirs: string[] = [];

  const appendEvent = (taskId: TaskId, type: TaskEventRecord['type'], payload: Record<string, unknown>) => {
    const list = eventsByTask.get(taskId) ?? [];
    const ev: TaskEventRecord = {
      id: `ev-${Date.now()}-${list.length}` as never,
      taskId,
      seq: list.length + 1,
      type,
      payload,
      createdAt: new Date().toISOString() as IsoTimestamp,
    };
    list.push(ev);
    eventsByTask.set(taskId, list);
    return ev;
  };

  return {
    isElectron: false,
    onMainEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    'tasks:list': async () => [...tasks.values()],
    'tasks:getCoordinator': async () => tasks.get(coordId)!,
    'tasks:getProjection': async ({ taskId }): Promise<TaskDetailProjection> => {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`任务不存在: ${taskId}`);
      return {
        task,
        profileSnapshot: task.profileVersionId ? (versions.get(task.profileVersionId) ?? null) : null,
        authorizedMaterials: materials.slice(0, 1),
        tabs: task.applyUrl
          ? [{ id: 'tab-preview' as never, taskId, url: task.applyUrl, title: task.title, active: true, loading: false }]
          : [],
        openTodo: null,
        pendingQuestion: null,
        activeConfirmation: null,
        events: eventsByTask.get(taskId) ?? [],
      };
    },
    'tasks:startApplication': async (input) => {
      const existing = [...tasks.values()].find(
        (t) => t.kind === 'application' && t.applyUrl === input.applyUrl && t.executionState !== 'closed',
      );
      if (existing) return { taskId: existing.id, reused: true };
      const id = `app-${Date.now()}` as TaskId;
      const profId = input.profileId ?? defaultProfile ?? defaultProfileId;
      const prof = profiles.get(profId);
      const t: TaskRecord = {
        id,
        kind: 'application',
        title: new URL(input.applyUrl).hostname,
        company: new URL(input.applyUrl).hostname,
        jobTitle: '待识别岗位',
        applyUrl: input.applyUrl,
        normalizedApplyUrl: input.applyUrl,
        originConversationId: input.originConversationId,
        profileVersionId: prof?.activeVersionId,
        browserProfileId: 'default' as BrowserProfileId,
        controlMode: 'human',
        executionState: 'queued',
        waitingReason: 'none',
        applicationStage: 'created',
        outcome: 'not_submitted',
        createdAt: new Date().toISOString() as IsoTimestamp,
        updatedAt: new Date().toISOString() as IsoTimestamp,
      };
      tasks.set(id, t);
      appendEvent(id, 'system_notice', { kind: 'task_created', applyUrl: input.applyUrl });
      emit({ type: 'tasks_changed', taskId: id });
      return { taskId: id, reused: false };
    },
    'tasks:sendMessage': async (input) => {
      appendEvent(input.taskId, 'user_message', { text: input.text });
      emit({ type: 'tasks_changed', taskId: input.taskId });
      return { accepted: true, duplicated: false };
    },
    'tasks:takeover': async ({ taskId }) => {
      const t = tasks.get(taskId);
      if (t) {
        tasks.set(taskId, { ...t, executionState: 'paused', waitingReason: 'manual_control', controlMode: 'human' });
        emit({ type: 'tasks_changed', taskId });
      }
    },
    'tasks:resumeCheck': async ({ taskId }) => {
      const t = tasks.get(taskId);
      if (t) {
        tasks.set(taskId, { ...t, executionState: 'queued', waitingReason: 'none' });
        appendEvent(taskId, 'user_message', { text: '已完成，请检查当前页面后继续。', isResumeCheck: true });
        emit({ type: 'tasks_changed', taskId });
      }
    },
    'tasks:close': async ({ taskId }) => {
      const t = tasks.get(taskId);
      if (t) {
        tasks.set(taskId, {
          ...t,
          executionState: 'closed',
          waitingReason: 'none',
          outcome: t.outcome === 'not_submitted' ? 'closed_without_submit' : t.outcome,
        });
        emit({ type: 'tasks_changed', taskId });
      }
    },
    'tasks:answerQuestion': async ({ taskId }) => {
      emit({ type: 'tasks_changed', taskId });
    },
    'tasks:resolveConfirmation': async ({ taskId, decision }) => {
      const t = tasks.get(taskId);
      if (t && decision === 'manual_submitted') {
        tasks.set(taskId, {
          ...t,
          executionState: 'closed',
          waitingReason: 'none',
          applicationStage: 'done',
          outcome: 'user_reported',
        });
      }
      emit({ type: 'tasks_changed', taskId });
    },
    'tasks:events': async ({ taskId }) => eventsByTask.get(taskId) ?? [],
    'browser:syncSurface': async () => {},
    'browser:navigate': async () => {},
    'browser:detachWindow': async () => {},
    'profiles:list': async () => ({ profiles: [...profiles.values()], defaultProfileId: defaultProfile }),
    'profiles:get': async ({ profileId }) => {
      const p = profiles.get(profileId);
      if (!p) return null;
      const snap = versions.get(p.activeVersionId)!;
      return {
        profile: p,
        snapshot: snap,
        versions: [...versions.values()].filter((v) => v.profileId === profileId),
      };
    },
    'profiles:create': async ({ name, content, setAsDefault }) => {
      const id = `prof-${Date.now()}` as ProfileId;
      const vid = `ver-${Date.now()}` as ProfileVersionId;
      const ts = new Date().toISOString() as IsoTimestamp;
      const p: ProfileRecord = { id, name, activeVersionId: vid, createdAt: ts, updatedAt: ts };
      const snap: ProfileVersionSnapshot = {
        id: vid,
        profileId: id,
        versionNumber: 1,
        content,
        contentHash: `hash-${Date.now()}` as never,
        createdAt: ts,
      };
      profiles.set(id, p);
      versions.set(vid, snap);
      if (setAsDefault) defaultProfile = id;
      return { profile: p, snapshot: snap };
    },
    'profiles:updateContent': async ({ profileId, content }) => {
      const p = profiles.get(profileId)!;
      const vid = `ver-${Date.now()}` as ProfileVersionId;
      const ts = new Date().toISOString() as IsoTimestamp;
      const nextVer = [...versions.values()].filter((v) => v.profileId === profileId).length + 1;
      const snap: ProfileVersionSnapshot = {
        id: vid,
        profileId,
        versionNumber: nextVer,
        content,
        contentHash: `hash-${Date.now()}` as never,
        createdAt: ts,
      };
      const updated = { ...p, activeVersionId: vid, updatedAt: ts };
      profiles.set(profileId, updated);
      versions.set(vid, snap);
      return { profile: updated, snapshot: snap };
    },
    'profiles:setDefault': async ({ profileId }) => {
      defaultProfile = profileId;
    },
    'profiles:setDefaultResume': async ({ profileId, materialId }) => {
      const p = profiles.get(profileId)!;
      const updated = { ...p, defaultResumeMaterialId: materialId };
      profiles.set(profileId, updated);
      return updated;
    },
    'materials:list': async () => [...materials],
    'materials:importBuffer': async (input) => {
      const rec: MaterialRecord = {
        id: `mat-${Date.now()}` as never,
        profileId: input.profileId,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: Math.round((input.base64Data.length * 3) / 4),
        sha256: 'preview-sha256' as never,
        relativePath: `materials/${input.fileName}`,
        createdAt: new Date().toISOString() as IsoTimestamp,
      };
      materials.unshift(rec);
      return rec;
    },
    'facts:list': async () => [...facts],
    'facts:remember': async (input) => {
      const ts = new Date().toISOString() as IsoTimestamp;
      const rec: UserFactRecord = {
        id: `fact-${Date.now()}`,
        profileId: input.profileId,
        scope: input.scope,
        key: input.key,
        value: input.value,
        source: 'user_edit',
        createdAt: ts,
        updatedAt: ts,
      };
      facts.unshift(rec);
      return rec;
    },
    'positions:list': async () => [...positions],
    'positions:add': async (input) => {
      const ts = new Date().toISOString() as IsoTimestamp;
      const pos: PositionRecord = {
        id: `pos-${Date.now()}` as PositionId,
        company: input.company,
        jobTitle: input.jobTitle,
        applyUrl: input.applyUrl,
        normalizedApplyUrl: input.applyUrl,
        sourceNote: input.sourceNote,
        progressStage: 'saved',
        createdAt: ts,
        updatedAt: ts,
      };
      positions.unshift(pos);
      return pos;
    },
    'positions:updateProgress': async ({ positionId, stage, closedReason, notes }) => {
      const found = positions.find((p) => p.id === positionId);
      if (found) {
        found.progressStage = stage;
        if (closedReason !== undefined) found.closedReason = closedReason;
        if (notes !== undefined) found.notes = notes;
      }
    },
    'providers:list': async () => [...providers],
    'providers:save': async (input) => {
      const ts = new Date().toISOString() as IsoTimestamp;
      const id = input.id ?? (`prov-${Date.now()}` as ProviderId);
      const summary: ProviderSummaryDto = {
        config: {
          id,
          name: input.name,
          providerType: input.providerType,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          credentialKey: `jobhelper.provider.${id}`,
          timeoutMs: input.timeoutMs ?? 60_000,
          maxContextTokens: input.maxContextTokens ?? 128_000,
          capabilities: { streaming: false, toolCalling: false, vision: false },
          isDefault: Boolean(input.isDefault ?? providers.length === 0),
          createdAt: ts,
          updatedAt: ts,
        },
        hasSecret: Boolean(input.apiKey),
      };
      const idx = providers.findIndex((p) => p.config.id === id);
      if (idx >= 0) providers[idx] = summary;
      else providers.push(summary);
      return summary;
    },
    'providers:delete': async ({ providerId }) => {
      const idx = providers.findIndex((p) => p.config.id === providerId);
      if (idx >= 0) providers.splice(idx, 1);
    },
    'providers:probe': async () => ({
      ok: false,
      error: '浏览器预览模式无法访问系统 safeStorage，请在 Electron 桌面端执行真实探测',
    }),
    'settings:get': async () => ({ maxConcurrent, externalSkillDirs }),
    'settings:update': async (input) => {
      if (input.maxConcurrent !== undefined) maxConcurrent = input.maxConcurrent;
      if (input.externalSkillDirs !== undefined) externalSkillDirs = input.externalSkillDirs;
      return { maxConcurrent, externalSkillDirs };
    },
    'skills:list': async () => ({
      catalogVersion: 'preview-builtin',
      externalDirs: externalSkillDirs,
      skills: [
        {
          name: 'form-controls',
          category: 'controls',
          source: 'builtin',
          description: 'JobHelper 通用招聘表单控件手册',
          byteLength: 820,
        },
        {
          name: 'form-dates',
          category: 'controls',
          source: 'builtin',
          description: 'JobHelper 日期与年月选择器手册',
          byteLength: 610,
        },
        {
          name: 'ats-beisen-primer',
          category: 'ats',
          source: 'builtin',
          description: '北森招聘系统（*.zhiye.com）JobHelper 适配入门手册',
          domainPatterns: ['*.zhiye.com'],
          byteLength: 590,
        },
      ],
    }),
    'skills:load': async ({ skillName }) => ({
      name: skillName,
      source: 'builtin',
      bodyMarkdown: `# ${skillName}\n\n请通过 Electron 桌面端加载实时磁盘正文。`,
    }),
    'skills:listDrafts': async () => [],
    'skills:reviewDraft': async () => {},
  };
}

let cachedBridge: JobHelperBridge | null = null;

export function getJobHelperBridge(): JobHelperBridge {
  if (cachedBridge) return cachedBridge;
  if (typeof window !== 'undefined' && window.jobHelper) {
    cachedBridge = { ...window.jobHelper, isElectron: true };
    return cachedBridge;
  }
  cachedBridge = createBrowserPreviewBridge();
  return cachedBridge;
}
