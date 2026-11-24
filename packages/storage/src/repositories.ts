import type {
  ActionLedgerRecord,
  ClientMessageId,
  ConfirmationCardRecord,
  ConfirmationId,
  ContentHash,
  MaterialId,
  MaterialRecord,
  ModelProviderConfig,
  ProfileId,
  ProfileRecord,
  ProfileVersionId,
  ProfileVersionSnapshot,
  ProviderId,
  QuestionCardRecord,
  RunId,
  TaskEventRecord,
  TaskId,
  TaskRecord,
  TodoCardRecord,
  UserFactRecord,
} from '@jobhelper/contracts';

/**
 * Storage transaction boundary contract. Implemented in M1 over SQLite.
 */
export interface StorageUnitOfWork {
  runInTransaction<T>(fn: () => T): T;
}

export interface TaskRepository {
  getById(taskId: TaskId): TaskRecord | null;
  findActiveApplicationByUrl(normalizedUrl: string): TaskRecord | null;
  listAll(): TaskRecord[];
  insert(task: TaskRecord, authorizedMaterialIds?: readonly MaterialId[]): void;
  update(task: TaskRecord): void;
  listAuthorizedMaterialIds(taskId: TaskId): MaterialId[];
  /** Called on app startup to mark any previously running/queued/stopping tasks as interrupted. */
  recoverInterruptedTasksOnStartup(nowIso: string): TaskId[];
}

export interface EventRepository {
  append(event: Omit<TaskEventRecord, 'seq'>): TaskEventRecord;
  hasClientMessage(taskId: TaskId, clientMessageId: ClientMessageId): boolean;
  listByTask(taskId: TaskId, afterSeq?: number): TaskEventRecord[];
}

export interface ProfileRepository {
  listProfiles(): ProfileRecord[];
  getProfile(profileId: ProfileId): ProfileRecord | null;
  getVersion(versionId: ProfileVersionId): ProfileVersionSnapshot | null;
  saveVersion(snapshot: ProfileVersionSnapshot): void;
  listMaterials(profileId?: ProfileId): MaterialRecord[];
  getMaterial(materialId: MaterialId): MaterialRecord | null;
  saveMaterial(material: MaterialRecord): void;
  listFacts(profileId?: ProfileId): UserFactRecord[];
  upsertFact(fact: UserFactRecord): void;
}

export interface HumanInTheLoopRepository {
  saveTodo(todo: TodoCardRecord): void;
  getOpenTodo(taskId: TaskId): TodoCardRecord | null;
  saveQuestionCard(card: QuestionCardRecord): void;
  getPendingQuestionCard(taskId: TaskId): QuestionCardRecord | null;
  saveConfirmation(card: ConfirmationCardRecord): void;
  getConfirmation(id: ConfirmationId): ConfirmationCardRecord | null;
  getActiveConfirmation(taskId: TaskId): ConfirmationCardRecord | null;
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
}

export interface ProviderRepository {
  list(): ModelProviderConfig[];
  getById(id: ProviderId): ModelProviderConfig | null;
  getDefault(): ModelProviderConfig | null;
  upsert(config: ModelProviderConfig): void;
  delete(id: ProviderId): void;
}
