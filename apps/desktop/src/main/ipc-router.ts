import crypto from 'node:crypto';
import type {
  AnswerQuestionInput,
  BrowserSurfaceLayoutInput,
  IsoTimestamp,
  MaterialId,
  MaterialKind,
  MaterialRecord,
  ModelCapabilities,
  ModelProviderConfig,
  PositionId,
  PositionProgressStage,
  PositionRecord,
  ProfileContent,
  ProfileId,
  ProfileRecord,
  ProfileVersionSnapshot,
  ProviderId,
  ProviderSummaryDto,
  RendererToMainIpc,
  ResolveConfirmationInput,
  SaveProviderInput,
  SendMessageInput,
  SkillDraftRecord,
  SkillSummaryDto,
  StartApplicationInput,
  TabId,
  TaskDetailProjection,
  TaskEventRecord,
  TaskId,
  TaskRecord,
  UserFactRecord,
} from '@jobhelper/contracts';
import type { LocalTaskTabManager } from '@jobhelper/browser-bridge';
import {
  normalizeApplyUrl,
  validateBrowserUrl,
  type LocalConfirmationService,
  type LocalMaterialService,
  type LocalProfileService,
  type LocalTaskScheduler,
  type LocalTaskService,
} from '@jobhelper/core';
import type { CredentialStore, ModelRouter } from '@jobhelper/model-router';
import type { LocalSkillCatalog } from '@jobhelper/skills';
import type { SqliteStorage } from '@jobhelper/storage';

const PREF_MAX_CONCURRENT = 'maxConcurrent';
const PREF_EXTERNAL_SKILL_DIRS = 'externalSkillDirs';

export interface DesktopIpcDependencies {
  storage: SqliteStorage;
  taskService: LocalTaskService;
  scheduler: LocalTaskScheduler;
  profiles: LocalProfileService;
  materials: LocalMaterialService;
  confirmations: LocalConfirmationService;
  tabs: LocalTaskTabManager;
  modelRouter: ModelRouter;
  credentials: CredentialStore;
  skills: LocalSkillCatalog;
  workbenchOrigin?: string;
  onDetachWindow?: (taskId: TaskId) => Promise<void> | void;
  onNotifyTasksChanged?: (taskId?: TaskId) => void;
}

/**
 * Complete typed implementation of all RendererToMainIpc channels.
 */
export class DesktopIpcRouter implements RendererToMainIpc {
  constructor(private readonly deps: DesktopIpcDependencies) {}

  'tasks:list' = async (): Promise<TaskRecord[]> => {
    return this.deps.storage.tasks.listAll();
  };

  'tasks:getCoordinator' = async (): Promise<TaskRecord> => {
    const existing = this.deps.storage.tasks.listAll().find((t) => t.kind === 'coordinator');
    if (existing) return existing;
    const created = this.deps.taskService.createCoordinatorConversation('JobHelper 求职总助手');
    this.deps.onNotifyTasksChanged?.(created.id);
    return created;
  };

  'tasks:getProjection' = async (input: { taskId: TaskId }): Promise<TaskDetailProjection> => {
    const task = this.deps.storage.tasks.getById(input.taskId);
    if (!task) {
      throw new Error(`任务不存在: ${input.taskId}`);
    }
    const profileSnapshot = task.profileVersionId
      ? this.deps.profiles.getSnapshot(task.profileVersionId)
      : null;
    const materialIds = this.deps.storage.tasks.listAuthorizedMaterialIds(task.id);
    const authorizedMaterials = materialIds
      .map((id) => this.deps.materials.getMaterial(id))
      .filter((m): m is MaterialRecord => m !== null);

    return {
      task,
      profileSnapshot,
      authorizedMaterials,
      tabs: this.deps.tabs.listTabs(task.id),
      openTodo: this.deps.storage.hitl.getOpenTodo(task.id),
      pendingQuestion: this.deps.storage.hitl.getPendingQuestionCard(task.id),
      activeConfirmation: this.deps.storage.hitl.getActiveConfirmation(task.id),
      events: this.deps.storage.events.listByTask(task.id, 0),
    };
  };

  'tasks:startApplication' = async (
    input: StartApplicationInput,
  ): Promise<{ taskId: TaskId; reused: boolean }> => {
    const { task, reused } = await this.deps.taskService.startApplication(input);
    if (!reused && task.applyUrl) {
      const existingTabs = this.deps.tabs.listTabs(task.id);
      if (existingTabs.length === 0) {
        await this.deps.tabs.createTab(task.id, task.applyUrl, task.browserProfileId);
      }
    }
    this.deps.onNotifyTasksChanged?.(task.id);
    if (!reused && this.deps.storage.providers.getDefault()) {
      void this.deps.scheduler.drain().catch(() => {});
    }
    return { taskId: task.id, reused };
  };

  'tasks:sendMessage' = async (
    input: SendMessageInput,
  ): Promise<{ accepted: boolean; duplicated: boolean }> => {
    const res = await this.deps.taskService.enqueueUserMessage(input);
    if (res.accepted) {
      this.deps.onNotifyTasksChanged?.(input.taskId);
      void this.deps.scheduler.drain().catch(() => {});
    }
    return res;
  };

  'tasks:takeover' = async (input: { taskId: TaskId }): Promise<void> => {
    await this.deps.taskService.requestTakeover(input.taskId);
    this.deps.onNotifyTasksChanged?.(input.taskId);
  };

  'tasks:resumeCheck' = async (input: { taskId: TaskId }): Promise<void> => {
    await this.deps.taskService.resumeAfterCheck(input.taskId);
    this.deps.onNotifyTasksChanged?.(input.taskId);
    void this.deps.scheduler.drain().catch(() => {});
  };

  'tasks:close' = async (input: { taskId: TaskId }): Promise<void> => {
    await this.deps.taskService.closeTask(input.taskId);
    await this.deps.tabs.closeAllTabsForTask(input.taskId);
    this.deps.onNotifyTasksChanged?.(input.taskId);
  };

  'tasks:answerQuestion' = async (input: AnswerQuestionInput): Promise<void> => {
    await this.deps.taskService.answerQuestion(input);
    this.deps.onNotifyTasksChanged?.(input.taskId);
    void this.deps.scheduler.drain().catch(() => {});
  };

  'tasks:resolveConfirmation' = async (input: ResolveConfirmationInput): Promise<void> => {
    const resolved = this.deps.confirmations.resolve(input);
    if (input.decision === 'manual_submitted') {
      const task = this.deps.taskService.transitionState({
        taskId: input.taskId,
        next: {
          executionState: 'closed',
          waitingReason: 'none',
          applicationStage: 'done',
          outcome: 'user_reported',
        },
        reason: `user_confirmed_manual_submission:${resolved.id}`,
        actor: 'user',
      });
      if (task.positionId) {
        this.deps.storage.positions.updateProgress(task.positionId, 'submitted_user_reported');
      }
    } else if (input.decision === 'decline') {
      this.deps.taskService.transitionState({
        taskId: input.taskId,
        next: {
          executionState: 'paused',
          waitingReason: 'manual_control',
        },
        reason: `user_declined_confirmation:${resolved.id}`,
        actor: 'user',
      });
    }
    this.deps.onNotifyTasksChanged?.(input.taskId);
  };

  'tasks:events' = async (input: { taskId: TaskId; afterSeq?: number }): Promise<TaskEventRecord[]> => {
    return this.deps.storage.events.listByTask(input.taskId, input.afterSeq ?? 0);
  };

  'browser:syncSurface' = async (input: BrowserSurfaceLayoutInput): Promise<void> => {
    this.deps.tabs.syncSurfaceBounds(input.taskId, input.visible, input.bounds);
  };

  'browser:navigate' = async (input: { taskId: TaskId; tabId: TabId; url: string }): Promise<void> => {
    const validUrl = validateBrowserUrl(input.url, this.deps.workbenchOrigin);
    await this.deps.taskService.requestTakeover(input.taskId);
    const managed = this.deps.tabs
      .getManagedTabs(input.taskId)
      .find((t) => t.id === input.tabId);
    if (!managed) {
      throw new Error(`标签页不属于当前任务: ${input.tabId}`);
    }
    await managed.view.webContents.loadURL(validUrl);
    this.deps.onNotifyTasksChanged?.(input.taskId);
  };

  'browser:detachWindow' = async (input: { taskId: TaskId }): Promise<void> => {
    await this.deps.taskService.requestTakeover(input.taskId);
    await this.deps.onDetachWindow?.(input.taskId);
  };

  'profiles:list' = async (): Promise<{ profiles: ProfileRecord[]; defaultProfileId: ProfileId | null }> => {
    return {
      profiles: this.deps.profiles.listProfiles(),
      defaultProfileId: this.deps.profiles.getDefaultProfileId(),
    };
  };

  'profiles:get' = async (input: { profileId: ProfileId }): Promise<{
    profile: ProfileRecord;
    snapshot: ProfileVersionSnapshot;
    versions: ProfileVersionSnapshot[];
  } | null> => {
    const active = this.deps.profiles.getProfileWithActiveVersion(input.profileId);
    if (!active) return null;
    return {
      ...active,
      versions: this.deps.profiles.listVersions(input.profileId),
    };
  };

  'profiles:create' = async (input: {
    name: string;
    content: ProfileContent;
    setAsDefault?: boolean;
  }): Promise<{ profile: ProfileRecord; snapshot: ProfileVersionSnapshot }> => {
    return this.deps.profiles.createProfile(input);
  };

  'profiles:updateContent' = async (input: {
    profileId: ProfileId;
    content: ProfileContent;
  }): Promise<{ profile: ProfileRecord; snapshot: ProfileVersionSnapshot }> => {
    return this.deps.profiles.updateProfileContent(input.profileId, input.content);
  };

  'profiles:setDefault' = async (input: { profileId: ProfileId }): Promise<void> => {
    this.deps.profiles.setDefaultProfileId(input.profileId);
  };

  'profiles:setDefaultResume' = async (input: {
    profileId: ProfileId;
    materialId?: MaterialId;
  }): Promise<ProfileRecord> => {
    return this.deps.profiles.setDefaultResumeMaterial(input.profileId, input.materialId);
  };

  'materials:list' = async (input?: { profileId?: ProfileId }): Promise<MaterialRecord[]> => {
    return this.deps.materials.listMaterials(input?.profileId);
  };

  'materials:importBuffer' = async (input: {
    profileId?: ProfileId;
    kind: MaterialKind;
    fileName: string;
    mimeType: string;
    base64Data: string;
  }): Promise<MaterialRecord> => {
    return this.deps.materials.importFromBuffer({
      profileId: input.profileId,
      kind: input.kind,
      fileName: input.fileName,
      mimeType: input.mimeType,
      data: Buffer.from(input.base64Data, 'base64'),
    });
  };

  'facts:list' = async (input?: { profileId?: ProfileId }): Promise<UserFactRecord[]> => {
    return this.deps.profiles.listFacts(input?.profileId);
  };

  'facts:remember' = async (input: {
    scope: 'global' | 'profile';
    profileId?: ProfileId;
    key: string;
    value: string;
  }): Promise<UserFactRecord> => {
    return this.deps.profiles.rememberFact({ ...input, source: 'user_edit' });
  };

  'positions:list' = async (): Promise<PositionRecord[]> => {
    return this.deps.storage.positions.listAll();
  };

  'positions:add' = async (input: {
    company: string;
    jobTitle: string;
    applyUrl: string;
    sourceNote?: string;
  }): Promise<PositionRecord> => {
    const validUrl = validateBrowserUrl(input.applyUrl, this.deps.workbenchOrigin);
    const normalized = normalizeApplyUrl(validUrl, this.deps.workbenchOrigin);
    const existing = this.deps.storage.positions.findByNormalizedUrl(normalized);
    if (existing) return existing;

    const now = new Date().toISOString() as IsoTimestamp;
    const record: PositionRecord = {
      id: crypto.randomUUID() as PositionId,
      company: input.company.trim(),
      jobTitle: input.jobTitle.trim(),
      applyUrl: validUrl,
      normalizedApplyUrl: normalized,
      sourceNote: input.sourceNote,
      progressStage: 'saved',
      createdAt: now,
      updatedAt: now,
    };
    this.deps.storage.positions.upsert(record);
    return record;
  };

  'positions:updateProgress' = async (input: {
    positionId: PositionId;
    stage: PositionProgressStage;
    closedReason?: string;
    notes?: string;
  }): Promise<void> => {
    this.deps.storage.positions.updateProgress(input.positionId, input.stage, {
      closedReason: input.closedReason,
      notes: input.notes,
    });
  };

  'providers:list' = async (): Promise<ProviderSummaryDto[]> => {
    const configs = this.deps.storage.providers.list();
    return Promise.all(
      configs.map(async (config) => ({
        config,
        hasSecret: await this.deps.credentials.hasSecret(config.credentialKey),
      })),
    );
  };

  'providers:save' = async (input: SaveProviderInput): Promise<ProviderSummaryDto> => {
    const now = new Date().toISOString() as IsoTimestamp;
    const existing = input.id ? this.deps.storage.providers.getById(input.id) : null;
    const id = existing?.id ?? (crypto.randomUUID() as ProviderId);
    const credentialKey = existing?.credentialKey ?? `jobhelper.provider.${id}`;

    const config: ModelProviderConfig = {
      id,
      name: input.name.trim(),
      providerType: input.providerType,
      baseUrl: input.baseUrl.trim(),
      modelId: input.modelId.trim(),
      credentialKey,
      timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? 60_000,
      maxContextTokens: input.maxContextTokens ?? existing?.maxContextTokens ?? 128_000,
      customHeaders: existing?.customHeaders,
      capabilities: existing?.capabilities ?? {
        streaming: false,
        toolCalling: false,
        vision: false,
      },
      isDefault: input.isDefault ?? existing?.isDefault ?? this.deps.storage.providers.list().length === 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (input.apiKey && input.apiKey.trim().length > 0) {
      await this.deps.credentials.setSecret(credentialKey, input.apiKey.trim());
    }
    this.deps.storage.providers.upsert(config);

    return {
      config,
      hasSecret: await this.deps.credentials.hasSecret(credentialKey),
    };
  };

  'providers:delete' = async (input: { providerId: ProviderId }): Promise<void> => {
    const existing = this.deps.storage.providers.getById(input.providerId);
    if (!existing) return;
    await this.deps.credentials.deleteSecret(existing.credentialKey);
    this.deps.storage.providers.delete(input.providerId);
  };

  'providers:probe' = async (input: {
    providerId: ProviderId;
  }): Promise<{ ok: boolean; capabilities?: ModelCapabilities; error?: string }> => {
    try {
      const capabilities = await this.deps.modelRouter.probe(input.providerId);
      return { ok: true, capabilities };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  'settings:get' = async (): Promise<{ maxConcurrent: number; externalSkillDirs: string[] }> => {
    return {
      maxConcurrent: this.deps.scheduler.getMaxConcurrent(),
      externalSkillDirs: this.deps.skills.getExternalDirs(),
    };
  };

  'settings:update' = async (input: {
    maxConcurrent?: number;
    externalSkillDirs?: string[];
  }): Promise<{ maxConcurrent: number; externalSkillDirs: string[] }> => {
    if (input.maxConcurrent !== undefined) {
      this.deps.scheduler.setMaxConcurrent(input.maxConcurrent);
      this.deps.storage.preferences.set(PREF_MAX_CONCURRENT, this.deps.scheduler.getMaxConcurrent());
    }
    if (input.externalSkillDirs !== undefined) {
      this.deps.skills.setExternalDirs(input.externalSkillDirs);
      this.deps.storage.preferences.set(PREF_EXTERNAL_SKILL_DIRS, this.deps.skills.getExternalDirs());
    }
    return {
      maxConcurrent: this.deps.scheduler.getMaxConcurrent(),
      externalSkillDirs: this.deps.skills.getExternalDirs(),
    };
  };

  'skills:list' = async (): Promise<{
    catalogVersion: string;
    skills: SkillSummaryDto[];
    externalDirs: string[];
  }> => {
    return {
      catalogVersion: this.deps.skills.getCatalogVersion(),
      externalDirs: this.deps.skills.getExternalDirs(),
      skills: this.deps.skills.listMetadata().map((s) => ({
        name: s.name,
        category: s.category,
        source: s.source,
        description: s.description,
        domainPatterns: s.domainPatterns,
        byteLength: s.byteLength,
      })),
    };
  };

  'skills:load' = async (input: {
    skillName: string;
  }): Promise<{ name: string; bodyMarkdown: string; source: 'builtin' | 'external' } | null> => {
    const doc = await this.deps.skills.loadSkill(input.skillName);
    if (!doc) return null;
    return {
      name: doc.manifest.name,
      bodyMarkdown: doc.bodyMarkdown,
      source: doc.manifest.source,
    };
  };

  'skills:listDrafts' = async (): Promise<SkillDraftRecord[]> => {
    return this.deps.storage.siteMemories.listSkillDrafts();
  };

  'skills:reviewDraft' = async (input: {
    draftId: string;
    status: 'approved' | 'rejected';
  }): Promise<void> => {
    this.deps.storage.siteMemories.reviewSkillDraft(
      input.draftId,
      input.status,
      new Date().toISOString(),
    );
  };
}

export interface ElectronIpcMainLike {
  handle(channel: string, listener: (_event: unknown, arg: unknown) => Promise<unknown>): void;
}

export const RENDERER_TO_MAIN_CHANNELS: readonly (keyof RendererToMainIpc)[] = [
  'tasks:list',
  'tasks:getCoordinator',
  'tasks:getProjection',
  'tasks:startApplication',
  'tasks:sendMessage',
  'tasks:takeover',
  'tasks:resumeCheck',
  'tasks:close',
  'tasks:answerQuestion',
  'tasks:resolveConfirmation',
  'tasks:events',
  'browser:syncSurface',
  'browser:navigate',
  'browser:detachWindow',
  'profiles:list',
  'profiles:get',
  'profiles:create',
  'profiles:updateContent',
  'profiles:setDefault',
  'profiles:setDefaultResume',
  'materials:list',
  'materials:importBuffer',
  'facts:list',
  'facts:remember',
  'positions:list',
  'positions:add',
  'positions:updateProgress',
  'providers:list',
  'providers:save',
  'providers:delete',
  'providers:probe',
  'settings:get',
  'settings:update',
  'skills:list',
  'skills:load',
  'skills:listDrafts',
  'skills:reviewDraft',
];

export function registerDesktopIpcHandlers(
  ipcMain: ElectronIpcMainLike,
  router: DesktopIpcRouter,
): void {
  for (const channel of RENDERER_TO_MAIN_CHANNELS) {
    ipcMain.handle(channel, async (_event, arg) => {
      const fn = router[channel] as (input?: unknown) => Promise<unknown>;
      return fn(arg);
    });
  }
}
