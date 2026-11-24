import type {
  ArtifactId,
  ContentHash,
  Epoch,
  IsoTimestamp,
  PositionId,
  RunId,
  TaskId,
} from './ids.js';
import type { ModelUsage, RunModelSnapshot } from './model.js';
import type { RunEndReason } from './state.js';

export type PositionProgressStage =
  | 'saved'
  | 'in_progress'
  | 'submitted_verified'
  | 'submitted_user_reported'
  | 'assessment'
  | 'interview'
  | 'offer'
  | 'closed';

export interface PositionRecord {
  id: PositionId;
  company: string;
  jobTitle: string;
  department?: string;
  applyUrl: string;
  normalizedApplyUrl: string;
  sourceNote?: string;
  deadlineAt?: IsoTimestamp;
  progressStage: PositionProgressStage;
  closedReason?: string;
  notes?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface TaskRunRecord {
  id: RunId;
  taskId: TaskId;
  epoch: Epoch;
  providerSnapshot: RunModelSnapshot;
  skillCatalogVersion?: string;
  endReason?: RunEndReason;
  usage?: ModelUsage;
  errorCode?: string;
  errorMessage?: string;
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
}

export type ArtifactKind =
  | 'screenshot'
  | 'confirmation_screenshot'
  | 'receipt_screenshot'
  | 'spill_text'
  | 'network_log';

export interface ArtifactRecord {
  id: ArtifactId;
  taskId: TaskId;
  runId?: RunId;
  kind: ArtifactKind;
  mimeType: string;
  sizeBytes: number;
  sha256: ContentHash;
  relativePath: string;
  label?: string;
  createdAt: IsoTimestamp;
}

export interface SiteMemoryRecord {
  id: string;
  domain: string;
  title: string;
  content: string;
  verified: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface SkillDraftRecord {
  id: string;
  skillName: string;
  sourceTaskId?: TaskId;
  diffOrContent: string;
  status: 'draft' | 'approved' | 'rejected';
  createdAt: IsoTimestamp;
  reviewedAt?: IsoTimestamp;
}
