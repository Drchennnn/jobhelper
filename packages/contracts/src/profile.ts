import type {
  ContentHash,
  IsoTimestamp,
  MaterialId,
  ProfileId,
  ProfileVersionId,
} from './ids.js';

export type MaterialKind = 'resume_pdf' | 'certificate' | 'transcript' | 'portfolio' | 'photo' | 'other';

export interface ProfileBasicInfo {
  fullName: string;
  phone?: string;
  email?: string;
  city?: string;
  gender?: string;
  birthDate?: string;
  wechat?: string;
  githubUrl?: string;
  portfolioUrl?: string;
}

export interface EducationEntry {
  school: string;
  degree: string;
  major: string;
  startDate: string;
  endDate: string;
  gpa?: string;
  ranking?: string;
  highlights?: string[];
}

export interface ExperienceEntry {
  organization: string;
  role: string;
  startDate: string;
  endDate: string;
  location?: string;
  summary: string;
  highlights?: string[];
}

export interface ProfileContent {
  basic: ProfileBasicInfo;
  education: EducationEntry[];
  internships: ExperienceEntry[];
  projects: ExperienceEntry[];
  skills: string[];
  languages?: string[];
  awards?: string[];
  selfEvaluation?: string;
  customFields?: Record<string, string>;
}

export interface ProfileRecord {
  id: ProfileId;
  name: string;
  activeVersionId: ProfileVersionId;
  defaultResumeMaterialId?: MaterialId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ProfileVersionSnapshot {
  id: ProfileVersionId;
  profileId: ProfileId;
  versionNumber: number;
  content: ProfileContent;
  contentHash: ContentHash;
  createdAt: IsoTimestamp;
}

export interface MaterialRecord {
  id: MaterialId;
  profileId?: ProfileId;
  kind: MaterialKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: ContentHash;
  /** Relative path inside the managed local materials directory. */
  relativePath: string;
  createdAt: IsoTimestamp;
}

export interface UserFactRecord {
  id: string;
  profileId?: ProfileId;
  scope: 'global' | 'profile';
  key: string;
  value: string;
  source: 'user_edit' | 'question_reply' | 'agent_confirmed';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
