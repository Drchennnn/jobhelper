import type {
  ActionLedgerRecord,
  ArtifactId,
  ArtifactRecord,
  CallId,
  ClientMessageId,
  ConfirmationCardRecord,
  ConfirmationId,
  ConfirmationStatus,
  ContentHash,
  Epoch,
  MaterialId,
  MaterialRecord,
  ModelProviderConfig,
  ModelUsage,
  PositionId,
  PositionProgressStage,
  PositionRecord,
  ProfileId,
  ProfileRecord,
  ProfileVersionId,
  ProfileVersionSnapshot,
  ProviderId,
  QuestionCardRecord,
  RunEndReason,
  RunId,
  SiteMemoryRecord,
  SkillDraftRecord,
  TaskEventRecord,
  TaskId,
  TaskRecord,
  TaskRunRecord,
  TodoCardRecord,
  TodoId,
  UserFactRecord,
} from '@jobhelper/contracts';

/**
 * Storage transaction boundary contract supporting nested savepoints.
 */
export interface StorageUnitOfWork {
  runInTransaction<T>(fn: () => T): T;
}

export interface PreferencesRepository {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown, updatedAt?: string): void;
  delete(key: string): void;
}

export interface TaskRepository {
  getById(taskId: TaskId): TaskRecord | null;
  findActiveApplicationByUrl(normalizedUrl: string): TaskRecord | null;
  listAll(): TaskRecord[];
  insert(task: TaskRecord, authorizedMaterialIds?: readonly MaterialId[]): void;
  update(task: TaskRecord): void;
  listAuthorizedMaterialIds(taskId: TaskId): MaterialId[];
  setAuthorizedMaterials(taskId: TaskId, materialIds: readonly MaterialId[], authorizedAt?: string): void;
  /** Called on app startup to mark any previously running/queued/stopping tasks as interrupted. */
  recoverInterruptedTasksOnStartup(nowIso: string): TaskId[];
}

export interface RunRepository {
  create(run: TaskRunRecord): void;
  getById(runId: RunId): TaskRunRecord | null;
  getByEpoch(epoch: Epoch): TaskRunRecord | null;
  listByTask(taskId: TaskId): TaskRunRecord[];
  finish(
    runId: RunId,
    details: {
      endReason: RunEndReason;
      finishedAt: string;
      usage?: ModelUsage;
      errorCode?: string;
      errorMessage?: string;
    },
  ): void;
}

export interface EventRepository {
  append<TPayload = Record<string, unknown>>(
    event: Omit<TaskEventRecord<TPayload>, 'seq'>,
  ): TaskEventRecord<TPayload>;
  hasClientMessage(taskId: TaskId, clientMessageId: ClientMessageId): boolean;
  listByTask(taskId: TaskId, afterSeq?: number): TaskEventRecord[];
}

export interface ProfileRepository {
  listProfiles(): ProfileRecord[];
  getProfile(profileId: ProfileId): ProfileRecord | null;
  saveProfile(profile: ProfileRecord): void;
  deleteProfile(profileId: ProfileId): void;
  getVersion(versionId: ProfileVersionId): ProfileVersionSnapshot | null;
  listVersions(profileId: ProfileId): ProfileVersionSnapshot[];
  getLatestVersionNumber(profileId: ProfileId): number;
  saveVersion(snapshot: ProfileVersionSnapshot): void;
  listMaterials(profileId?: ProfileId): MaterialRecord[];
  getMaterial(materialId: MaterialId): MaterialRecord | null;
  saveMaterial(material: MaterialRecord): void;
  deleteMaterial(materialId: MaterialId): void;
  listFacts(profileId?: ProfileId): UserFactRecord[];
  upsertFact(fact: UserFactRecord): void;
  deleteFact(factId: string): void;
}

export interface PositionRepository {
  getById(id: PositionId): PositionRecord | null;
  findByNormalizedUrl(normalizedApplyUrl: string): PositionRecord | null;
  listAll(): PositionRecord[];
  upsert(position: PositionRecord): void;
  updateProgress(
    id: PositionId,
    stage: PositionProgressStage,
    details?: { closedReason?: string; notes?: string; updatedAt?: string },
  ): void;
}

export interface HumanInTheLoopRepository {
  saveTodo(todo: TodoCardRecord): void;
  getOpenTodo(taskId: TaskId): TodoCardRecord | null;
  resolveTodo(id: TodoId, status: 'resolved' | 'cancelled', resolvedAt: string): void;
  saveQuestionCard(card: QuestionCardRecord): void;
  getQuestionCard(id: string): QuestionCardRecord | null;
  getQuestionCardByCallId(taskId: TaskId, callId: CallId): QuestionCardRecord | null;
  getPendingQuestionCard(taskId: TaskId): QuestionCardRecord | null;
  recordQuestionAnswers(
    id: string,
    answers: NonNullable<QuestionCardRecord['answers']>,
    answeredAt: string,
  ): void;
  markQuestionReplyInjected(id: string, runId: RunId): void;
  saveConfirmation(card: ConfirmationCardRecord): void;
  getConfirmation(id: ConfirmationId): ConfirmationCardRecord | null;
  getActiveConfirmation(taskId: TaskId): ConfirmationCardRecord | null;
  updateConfirmationStatus(id: ConfirmationId, status: ConfirmationStatus, resolvedAt: string): void;
  invalidateConfirmations(taskId: TaskId, reason: string, nowIso: string): number;
  verifyContentHashMatches(id: ConfirmationId, expectedHash: ContentHash): boolean;
}

export interface ActionLedgerRepository {
  record(entry: ActionLedgerRecord): void;
  updateStatus(
    id: string,
    status: ActionLedgerRecord['status'],
    details?: { readbackSummary?: string; errorMessage?: string; updatedAt: string },
  ): void;
  listByRun(runId: RunId): ActionLedgerRecord[];
  listByTask(taskId: TaskId): ActionLedgerRecord[];
}

export interface ArtifactRepository {
  save(artifact: ArtifactRecord): void;
  getById(id: ArtifactId): ArtifactRecord | null;
  listByTask(taskId: TaskId): ArtifactRecord[];
}

export interface ProviderRepository {
  list(): ModelProviderConfig[];
  getById(id: ProviderId): ModelProviderConfig | null;
  getDefault(): ModelProviderConfig | null;
  upsert(config: ModelProviderConfig): void;
  delete(id: ProviderId): void;
}

export interface SiteMemoryRepository {
  listByDomain(domain: string): SiteMemoryRecord[];
  upsert(memory: SiteMemoryRecord): void;
  saveSkillDraft(draft: SkillDraftRecord): void;
  listSkillDrafts(status?: SkillDraftRecord['status']): SkillDraftRecord[];
  reviewSkillDraft(id: string, status: 'approved' | 'rejected', reviewedAt: string): void;
}
