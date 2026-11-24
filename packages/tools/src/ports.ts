import type {
  ArtifactId,
  BrowserActCommand,
  BrowserActResult,
  BrowserObservationSnapshot,
  ContentHash,
  Epoch,
  MaterialId,
  PositionId,
  PositionProgressStage,
  PositionRecord,
  ProfileContent,
  ProfileId,
  ProfileRecord,
  ProfileVersionId,
  ProfileVersionSnapshot,
  QuestionItem,
  RunId,
  SiteMemoryRecord,
  SkillDraftRecord,
  StartApplicationInput,
  TabId,
  TaskId,
  TaskRecord,
  TaskTabInfo,
  UserFactRecord,
  WaitingReason,
} from '@jobhelper/contracts';

/**
 * Dependency ports injected into @jobhelper/tools factories so the tool layer stays
 * decoupled from concrete Electron/SQLite implementations and 100% testable.
 */
export interface BrowserToolsPort {
  observe(taskId: TaskId, epoch: Epoch, tabId?: TabId): Promise<BrowserObservationSnapshot>;
  act(command: BrowserActCommand): Promise<BrowserActResult>;
  captureScreenshot(
    taskId: TaskId,
    epoch: Epoch,
    options?: { tabId?: TabId; fullPage?: boolean; label?: string },
  ): Promise<{ artifactId: ArtifactId; width: number; height: number; sha256: ContentHash }>;
  listTabs(taskId: TaskId): TaskTabInfo[];
  selectTab(taskId: TaskId, tabId: TabId): void;
  openTab(taskId: TaskId, url: string): Promise<TaskTabInfo>;
  closeTab(taskId: TaskId, tabId: TabId): Promise<void>;
  inspectControl(taskId: TaskId, epoch: Epoch, ref: string): Promise<Record<string, unknown>>;
  listNetworkEvents(taskId: TaskId, filter?: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  readSpill(spillId: string, offset?: number, limit?: number): Promise<{ content: string; nextOffset: number | null }>;
  runReadOnlyProbe(taskId: TaskId, epoch: Epoch, probe: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ApplicationBusinessPort {
  getLockedProfile(versionId: ProfileVersionId): {
    snapshot: ProfileVersionSnapshot;
    facts: UserFactRecord[];
  } | null;
  readAuthorizedMaterial(
    materialId: MaterialId,
    authorizedMaterialIds: readonly MaterialId[],
    offset?: number,
    limit?: number,
  ): Promise<{ fileName: string; mimeType: string; content: string; nextOffset: number | null }>;
  askUserQuestion(input: {
    taskId: TaskId;
    runId: RunId;
    callId: string;
    questions: QuestionItem[];
  }): Promise<{ status: 'answered' | 'pending'; answers?: Record<string, string> }>;
  requestUserAction(input: {
    taskId: TaskId;
    runId: RunId;
    reason: WaitingReason;
    summary: string;
    instructions: string;
  }): Promise<{ todoId: string }>;
  reportFillingReady(input: {
    taskId: TaskId;
    filledSummary: string;
    missingItems: string[];
    attachmentIds: MaterialId[];
  }): Promise<void>;
  requestSubmissionConfirmation(input: {
    taskId: TaskId;
    runId: RunId;
    company?: string;
    jobTitle?: string;
    keyFields: Array<{ label: string; value: string }>;
    missingItems: string[];
    attachmentIds: MaterialId[];
    screenshotArtifactIds: ArtifactId[];
    contentHash: ContentHash;
    instructions?: string;
  }): Promise<{ confirmationId: string }>;
  requestOperationConfirmation(input: {
    taskId: TaskId;
    runId: RunId;
    operation: 'save_draft' | 'irreversible_step';
    summary: string;
    contentHash: ContentHash;
  }): Promise<{ confirmationId: string }>;
  reportSubmitAttempted(input: {
    taskId: TaskId;
    source: 'user_manual' | 'authorized_click';
    evidenceNote: string;
  }): Promise<void>;
  reportSubmissionResult(input: {
    taskId: TaskId;
    verified: boolean;
    receiptText?: string;
    receiptUrl?: string;
    screenshotArtifactId?: ArtifactId;
  }): Promise<{ outcome: TaskRecord['outcome']; applicationStage: TaskRecord['applicationStage'] }>;
  updateTaskDetails(input: {
    taskId: TaskId;
    company?: string;
    jobTitle?: string;
  }): Promise<void>;
  rememberUserInfo(input: {
    taskId: TaskId;
    key: string;
    value: string;
    confirmedByUser: boolean;
  }): Promise<{ factId: string }>;
  reportJobUnavailable(input: {
    taskId: TaskId;
    reason: string;
    evidenceText: string;
  }): Promise<void>;
  searchSiteMemories(domain: string): SiteMemoryRecord[];
  saveSiteMemory(input: { domain: string; title: string; content: string }): SiteMemoryRecord;
  listSkills(filter?: { domain?: string }): Array<{ name: string; description: string; category: string }>;
  loadSkill(skillName: string): Promise<{ name: string; bodyMarkdown: string; catalogVersion: string } | null>;
  submitSkillDraft?(input: {
    taskId: TaskId;
    skillName: string;
    diffOrContent: string;
  }): SkillDraftRecord;
}

export interface CoordinatorBusinessPort {
  getCareerOverview(): {
    defaultProfileId: ProfileId | null;
    profiles: ProfileRecord[];
    positionsCount: number;
    activeApplicationsCount: number;
  };
  readProfile(profileId?: ProfileId): {
    profile: ProfileRecord;
    snapshot: ProfileVersionSnapshot;
    facts: UserFactRecord[];
  } | null;
  editProfile(input: {
    profileId: ProfileId;
    nextContent: ProfileContent;
    confirmed?: boolean;
  }): { profile: ProfileRecord; snapshot: ProfileVersionSnapshot };
  listMaterials(profileId?: ProfileId): Array<{
    id: MaterialId;
    fileName: string;
    kind: string;
    sizeBytes: number;
  }>;
  readMaterial(
    materialId: MaterialId,
    offset?: number,
    limit?: number,
  ): Promise<{ fileName: string; mimeType: string; content: string; nextOffset: number | null }>;
  rememberUserInfo(input: {
    scope: 'global' | 'profile';
    profileId?: ProfileId;
    key: string;
    value: string;
  }): UserFactRecord;
  addTrackedPosition(input: {
    company: string;
    jobTitle: string;
    applyUrl: string;
    sourceNote?: string;
  }): PositionRecord;
  updateProgress(input: {
    positionId: PositionId;
    stage: PositionProgressStage;
    closedReason?: string;
    notes?: string;
  }): void;
  startApplication(input: StartApplicationInput): Promise<{ task: TaskRecord; reused: boolean }>;
  listApplicationTasks(taskIds?: readonly TaskId[]): TaskRecord[];
}
