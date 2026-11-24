import type {
  ClientMessageId,
  ConfirmationCardRecord,
  ConfirmationId,
  Epoch,
  MaterialId,
  MaterialKind,
  MaterialRecord,
  ModelCapabilities,
  ModelProviderConfig,
  ModelProviderType,
  PositionId,
  PositionProgressStage,
  PositionRecord,
  ProfileContent,
  ProfileId,
  ProfileRecord,
  ProfileVersionSnapshot,
  ProviderId,
  QuestionCardRecord,
  QuestionId,
  RunId,
  SkillDraftRecord,
  TabId,
  TaskEventRecord,
  TaskId,
  TaskRecord,
  TaskTabInfo,
  TodoCardRecord,
  UserFactRecord,
  ViewportRect,
} from './index.js';
import type { StreamDeltaEvent } from './events.js';

export interface StartApplicationInput {
  applyUrl: string;
  positionId?: PositionId;
  profileId?: ProfileId;
  materialIds?: MaterialId[];
  note?: string;
  originConversationId?: TaskId;
}

export interface SendMessageInput {
  taskId: TaskId;
  clientMessageId: ClientMessageId;
  text: string;
  materialIds?: MaterialId[];
}

export interface AnswerQuestionInput {
  taskId: TaskId;
  questionCardId: string;
  answers: Array<{
    questionId: QuestionId;
    value: string;
    saveToProfile: boolean;
  }>;
}

export interface ResolveConfirmationInput {
  taskId: TaskId;
  confirmationId: ConfirmationId;
  decision: 'approve' | 'decline' | 'manual_submitted';
}

export interface BrowserSurfaceLayoutInput {
  taskId: TaskId | null;
  visible: boolean;
  bounds: ViewportRect;
}

export interface TaskDetailProjection {
  task: TaskRecord;
  profileSnapshot: ProfileVersionSnapshot | null;
  authorizedMaterials: MaterialRecord[];
  tabs: TaskTabInfo[];
  openTodo: TodoCardRecord | null;
  pendingQuestion: QuestionCardRecord | null;
  activeConfirmation: ConfirmationCardRecord | null;
  events: TaskEventRecord[];
}

export interface ProviderSummaryDto {
  config: ModelProviderConfig;
  /** Renderer only sees whether a secret exists in safeStorage — NEVER plaintext. */
  hasSecret: boolean;
}

export interface SaveProviderInput {
  id?: ProviderId;
  name: string;
  providerType: ModelProviderType;
  baseUrl: string;
  modelId: string;
  /** Optional plaintext secret written directly to safeStorage; omit/empty to keep existing key. */
  apiKey?: string;
  timeoutMs?: number;
  maxContextTokens?: number;
  isDefault?: boolean;
}

export interface SkillSummaryDto {
  name: string;
  category: 'ats' | 'controls' | 'custom';
  source: 'builtin' | 'external';
  description: string;
  domainPatterns?: string[];
  byteLength: number;
}

export interface MainToRendererEvent {
  type: 'tasks_changed' | 'stream_delta' | 'task_event';
  taskId?: TaskId;
  delta?: StreamDeltaEvent;
  event?: TaskEventRecord;
}

/**
 * Typed IPC channel catalog between Renderer (apps/workbench) and Electron Main Process.
 */
export interface RendererToMainIpc {
  // Tasks & Coordinator
  'tasks:list': () => Promise<TaskRecord[]>;
  'tasks:getCoordinator': () => Promise<TaskRecord>;
  'tasks:getProjection': (input: { taskId: TaskId }) => Promise<TaskDetailProjection>;
  'tasks:startApplication': (input: StartApplicationInput) => Promise<{ taskId: TaskId; reused: boolean }>;
  'tasks:sendMessage': (input: SendMessageInput) => Promise<{ accepted: boolean; duplicated: boolean }>;
  'tasks:takeover': (input: { taskId: TaskId }) => Promise<void>;
  'tasks:resumeCheck': (input: { taskId: TaskId }) => Promise<void>;
  'tasks:close': (input: { taskId: TaskId }) => Promise<void>;
  'tasks:answerQuestion': (input: AnswerQuestionInput) => Promise<void>;
  'tasks:resolveConfirmation': (input: ResolveConfirmationInput) => Promise<void>;
  'tasks:events': (input: { taskId: TaskId; afterSeq?: number }) => Promise<TaskEventRecord[]>;

  // Browser Surface & Navigation
  'browser:syncSurface': (input: BrowserSurfaceLayoutInput) => Promise<void>;
  'browser:navigate': (input: { taskId: TaskId; tabId: TabId; url: string }) => Promise<void>;
  'browser:detachWindow': (input: { taskId: TaskId }) => Promise<void>;

  // Profiles, Immutable Snapshots, Materials & Facts
  'profiles:list': () => Promise<{ profiles: ProfileRecord[]; defaultProfileId: ProfileId | null }>;
  'profiles:get': (input: { profileId: ProfileId }) => Promise<{
    profile: ProfileRecord;
    snapshot: ProfileVersionSnapshot;
    versions: ProfileVersionSnapshot[];
  } | null>;
  'profiles:create': (input: {
    name: string;
    content: ProfileContent;
    setAsDefault?: boolean;
  }) => Promise<{ profile: ProfileRecord; snapshot: ProfileVersionSnapshot }>;
  'profiles:updateContent': (input: {
    profileId: ProfileId;
    content: ProfileContent;
  }) => Promise<{ profile: ProfileRecord; snapshot: ProfileVersionSnapshot }>;
  'profiles:setDefault': (input: { profileId: ProfileId }) => Promise<void>;
  'profiles:setDefaultResume': (input: { profileId: ProfileId; materialId?: MaterialId }) => Promise<ProfileRecord>;
  'materials:list': (input?: { profileId?: ProfileId }) => Promise<MaterialRecord[]>;
  'materials:importBuffer': (input: {
    profileId?: ProfileId;
    kind: MaterialKind;
    fileName: string;
    mimeType: string;
    base64Data: string;
  }) => Promise<MaterialRecord>;
  'facts:list': (input?: { profileId?: ProfileId }) => Promise<UserFactRecord[]>;
  'facts:remember': (input: {
    scope: 'global' | 'profile';
    profileId?: ProfileId;
    key: string;
    value: string;
  }) => Promise<UserFactRecord>;

  // Local Job Progress Tracker
  'positions:list': () => Promise<PositionRecord[]>;
  'positions:add': (input: {
    company: string;
    jobTitle: string;
    applyUrl: string;
    sourceNote?: string;
  }) => Promise<PositionRecord>;
  'positions:updateProgress': (input: {
    positionId: PositionId;
    stage: PositionProgressStage;
    closedReason?: string;
    notes?: string;
  }) => Promise<void>;

  // BYOK Providers & App Settings
  'providers:list': () => Promise<ProviderSummaryDto[]>;
  'providers:save': (input: SaveProviderInput) => Promise<ProviderSummaryDto>;
  'providers:delete': (input: { providerId: ProviderId }) => Promise<void>;
  'providers:probe': (input: { providerId: ProviderId }) => Promise<{
    ok: boolean;
    capabilities?: ModelCapabilities;
    error?: string;
  }>;
  'settings:get': () => Promise<{ maxConcurrent: number; externalSkillDirs: string[] }>;
  'settings:update': (input: {
    maxConcurrent?: number;
    externalSkillDirs?: string[];
  }) => Promise<{ maxConcurrent: number; externalSkillDirs: string[] }>;

  // On-Demand Local Skills & Drafts (Option A: Builtin + User-Mounted External Dirs)
  'skills:list': () => Promise<{ catalogVersion: string; skills: SkillSummaryDto[]; externalDirs: string[] }>;
  'skills:load': (input: { skillName: string }) => Promise<{ name: string; bodyMarkdown: string; source: 'builtin' | 'external' } | null>;
  'skills:listDrafts': () => Promise<SkillDraftRecord[]>;
  'skills:reviewDraft': (input: { draftId: string; status: 'approved' | 'rejected' }) => Promise<void>;
}

/**
 * Main Process <-> Shared Agent Worker protocol messages.
 */
export type MainToWorkerMessage =
  | { type: 'run_start'; taskId: TaskId; runId: RunId; epoch: Epoch }
  | { type: 'run_stop'; taskId: TaskId; reason: string }
  | { type: 'question_reply'; taskId: TaskId; questionCardId: string; answers: AnswerQuestionInput['answers'] }
  | { type: 'message_splice'; taskId: TaskId; clientMessageId: ClientMessageId; text: string }
  | { type: 'rpc_reply'; requestId: string; ok: boolean; data?: unknown; error?: string };

export type WorkerToMainMessage =
  | { type: 'worker_ready' }
  | { type: 'stream_delta'; delta: StreamDeltaEvent }
  | { type: 'run_finished'; taskId: TaskId; runId: RunId; epoch: Epoch; endReason: string; error?: string }
  | { type: 'run_stopped_ack'; taskId: TaskId }
  | { type: 'rpc_request'; requestId: string; taskId: TaskId; epoch: Epoch; method: string; params: unknown };
