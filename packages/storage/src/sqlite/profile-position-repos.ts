import type {
  ContentHash,
  IsoTimestamp,
  MaterialId,
  MaterialKind,
  MaterialRecord,
  PositionId,
  PositionProgressStage,
  PositionRecord,
  ProfileContent,
  ProfileId,
  ProfileRecord,
  ProfileVersionId,
  ProfileVersionSnapshot,
  UserFactRecord,
} from '@jobhelper/contracts';
import type { JobHelperDatabase } from '../database.js';
import type { PositionRepository, ProfileRepository } from '../repositories.js';

interface ProfileRow {
  id: string;
  name: string;
  active_version_id: string | null;
  default_resume_material_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProfileVersionRow {
  id: string;
  profile_id: string;
  version_number: number;
  content_json: string;
  content_sha256: string;
  created_at: string;
}

interface MaterialRow {
  id: string;
  profile_id: string | null;
  kind: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  relative_path: string;
  created_at: string;
}

interface UserFactRow {
  id: string;
  profile_id: string | null;
  scope: string;
  fact_key: string;
  fact_value: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface PositionRow {
  id: string;
  company: string;
  job_title: string;
  department: string | null;
  apply_url: string;
  normalized_apply_url: string;
  source_note: string | null;
  deadline_at: string | null;
  progress_stage: string;
  closed_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function mapProfile(row: ProfileRow): ProfileRecord {
  return {
    id: row.id as ProfileId,
    name: row.name,
    activeVersionId: (row.active_version_id ?? '') as ProfileVersionId,
    defaultResumeMaterialId: row.default_resume_material_id
      ? (row.default_resume_material_id as MaterialId)
      : undefined,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapVersion(row: ProfileVersionRow): ProfileVersionSnapshot {
  return {
    id: row.id as ProfileVersionId,
    profileId: row.profile_id as ProfileId,
    versionNumber: row.version_number,
    content: JSON.parse(row.content_json) as ProfileContent,
    contentHash: row.content_sha256 as ContentHash,
    createdAt: row.created_at as IsoTimestamp,
  };
}

function mapMaterial(row: MaterialRow): MaterialRecord {
  return {
    id: row.id as MaterialId,
    profileId: row.profile_id ? (row.profile_id as ProfileId) : undefined,
    kind: row.kind as MaterialKind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256 as ContentHash,
    relativePath: row.relative_path,
    createdAt: row.created_at as IsoTimestamp,
  };
}

function mapFact(row: UserFactRow): UserFactRecord {
  return {
    id: row.id,
    profileId: row.profile_id ? (row.profile_id as ProfileId) : undefined,
    scope: row.scope as UserFactRecord['scope'],
    key: row.fact_key,
    value: row.fact_value,
    source: row.source as UserFactRecord['source'],
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapPosition(row: PositionRow): PositionRecord {
  return {
    id: row.id as PositionId,
    company: row.company,
    jobTitle: row.job_title,
    department: row.department ?? undefined,
    applyUrl: row.apply_url,
    normalizedApplyUrl: row.normalized_apply_url,
    sourceNote: row.source_note ?? undefined,
    deadlineAt: row.deadline_at ? (row.deadline_at as IsoTimestamp) : undefined,
    progressStage: row.progress_stage as PositionProgressStage,
    closedReason: row.closed_reason ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

export class SqliteProfileRepository implements ProfileRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  listProfiles(): ProfileRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM profiles ORDER BY created_at ASC')
      .all() as unknown as ProfileRow[];
    return rows.map(mapProfile);
  }

  getProfile(profileId: ProfileId): ProfileRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM profiles WHERE id = ?')
      .get(profileId) as ProfileRow | undefined;
    return row ? mapProfile(row) : null;
  }

  saveProfile(profile: ProfileRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO profiles (id, name, active_version_id, default_resume_material_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           active_version_id = excluded.active_version_id,
           default_resume_material_id = excluded.default_resume_material_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        profile.id,
        profile.name,
        profile.activeVersionId || null,
        profile.defaultResumeMaterialId ?? null,
        profile.createdAt,
        profile.updatedAt,
      );
  }

  deleteProfile(profileId: ProfileId): void {
    this.db.sqlite.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
  }

  getVersion(versionId: ProfileVersionId): ProfileVersionSnapshot | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM profile_versions WHERE id = ?')
      .get(versionId) as ProfileVersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  listVersions(profileId: ProfileId): ProfileVersionSnapshot[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM profile_versions WHERE profile_id = ? ORDER BY version_number DESC')
      .all(profileId) as unknown as ProfileVersionRow[];
    return rows.map(mapVersion);
  }

  getLatestVersionNumber(profileId: ProfileId): number {
    const row = this.db.sqlite
      .prepare('SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM profile_versions WHERE profile_id = ?')
      .get(profileId) as { max_ver: number };
    return row.max_ver;
  }

  saveVersion(snapshot: ProfileVersionSnapshot): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO profile_versions (id, profile_id, version_number, content_json, content_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.profileId,
        snapshot.versionNumber,
        JSON.stringify(snapshot.content),
        snapshot.contentHash,
        snapshot.createdAt,
      );
  }

  listMaterials(profileId?: ProfileId): MaterialRecord[] {
    const rows = profileId
      ? (this.db.sqlite
          .prepare('SELECT * FROM materials WHERE profile_id = ? ORDER BY created_at DESC')
          .all(profileId) as unknown as MaterialRow[])
      : (this.db.sqlite
          .prepare('SELECT * FROM materials ORDER BY created_at DESC')
          .all() as unknown as MaterialRow[]);
    return rows.map(mapMaterial);
  }

  getMaterial(materialId: MaterialId): MaterialRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM materials WHERE id = ?')
      .get(materialId) as MaterialRow | undefined;
    return row ? mapMaterial(row) : null;
  }

  saveMaterial(material: MaterialRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO materials (
           id, profile_id, kind, file_name, mime_type, size_bytes, sha256, relative_path, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           profile_id = excluded.profile_id,
           kind = excluded.kind,
           file_name = excluded.file_name,
           mime_type = excluded.mime_type`,
      )
      .run(
        material.id,
        material.profileId ?? null,
        material.kind,
        material.fileName,
        material.mimeType,
        material.sizeBytes,
        material.sha256,
        material.relativePath,
        material.createdAt,
      );
  }

  deleteMaterial(materialId: MaterialId): void {
    this.db.sqlite.prepare('DELETE FROM materials WHERE id = ?').run(materialId);
  }

  listFacts(profileId?: ProfileId): UserFactRecord[] {
    const rows = profileId
      ? (this.db.sqlite
          .prepare(
            `SELECT * FROM user_facts
             WHERE scope = 'global' OR profile_id = ?
             ORDER BY updated_at DESC`,
          )
          .all(profileId) as unknown as UserFactRow[])
      : (this.db.sqlite
          .prepare('SELECT * FROM user_facts ORDER BY updated_at DESC')
          .all() as unknown as UserFactRow[]);
    return rows.map(mapFact);
  }

  upsertFact(fact: UserFactRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO user_facts (id, profile_id, scope, fact_key, fact_value, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fact_key = excluded.fact_key,
           fact_value = excluded.fact_value,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(
        fact.id,
        fact.profileId ?? null,
        fact.scope,
        fact.key,
        fact.value,
        fact.source,
        fact.createdAt,
        fact.updatedAt,
      );
  }

  deleteFact(factId: string): void {
    this.db.sqlite.prepare('DELETE FROM user_facts WHERE id = ?').run(factId);
  }
}

export class SqlitePositionRepository implements PositionRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  getById(id: PositionId): PositionRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM positions WHERE id = ?')
      .get(id) as PositionRow | undefined;
    return row ? mapPosition(row) : null;
  }

  findByNormalizedUrl(normalizedApplyUrl: string): PositionRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM positions WHERE normalized_apply_url = ? LIMIT 1')
      .get(normalizedApplyUrl) as PositionRow | undefined;
    return row ? mapPosition(row) : null;
  }

  listAll(): PositionRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM positions ORDER BY updated_at DESC')
      .all() as unknown as PositionRow[];
    return rows.map(mapPosition);
  }

  upsert(position: PositionRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO positions (
           id, company, job_title, department, apply_url, normalized_apply_url,
           source_note, deadline_at, progress_stage, closed_reason, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           company = excluded.company,
           job_title = excluded.job_title,
           department = excluded.department,
           apply_url = excluded.apply_url,
           normalized_apply_url = excluded.normalized_apply_url,
           source_note = excluded.source_note,
           deadline_at = excluded.deadline_at,
           progress_stage = excluded.progress_stage,
           closed_reason = excluded.closed_reason,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      )
      .run(
        position.id,
        position.company,
        position.jobTitle,
        position.department ?? null,
        position.applyUrl,
        position.normalizedApplyUrl,
        position.sourceNote ?? null,
        position.deadlineAt ?? null,
        position.progressStage,
        position.closedReason ?? null,
        position.notes ?? null,
        position.createdAt,
        position.updatedAt,
      );
  }

  updateProgress(
    id: PositionId,
    stage: PositionProgressStage,
    details?: { closedReason?: string; notes?: string; updatedAt?: string },
  ): void {
    const updatedAt = details?.updatedAt ?? new Date().toISOString();
    this.db.sqlite
      .prepare(
        `UPDATE positions
         SET progress_stage = ?,
             closed_reason = COALESCE(?, closed_reason),
             notes = COALESCE(?, notes),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(stage, details?.closedReason ?? null, details?.notes ?? null, updatedAt, id);
  }
}
