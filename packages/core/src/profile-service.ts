import crypto from 'node:crypto';
import type {
  IsoTimestamp,
  MaterialId,
  ProfileContent,
  ProfileId,
  ProfileRecord,
  ProfileVersionId,
  ProfileVersionSnapshot,
  UserFactRecord,
} from '@jobhelper/contracts';
import type {
  PreferencesRepository,
  ProfileRepository,
  StorageUnitOfWork,
} from '@jobhelper/storage';
import { sha256Json } from './hash.js';
import type { ProfileBindingService } from './services.js';

const DEFAULT_PROFILE_PREF_KEY = 'defaultProfileId';

export interface ProfileWithSnapshot {
  profile: ProfileRecord;
  snapshot: ProfileVersionSnapshot;
}

export class LocalProfileService implements ProfileBindingService {
  constructor(
    private readonly uow: StorageUnitOfWork,
    private readonly profiles: ProfileRepository,
    private readonly preferences: PreferencesRepository,
  ) {}

  listProfiles(): ProfileRecord[] {
    return this.profiles.listProfiles();
  }

  getProfileWithActiveVersion(profileId: ProfileId): ProfileWithSnapshot | null {
    const profile = this.profiles.getProfile(profileId);
    if (!profile) return null;
    const snapshot = this.profiles.getVersion(profile.activeVersionId);
    if (!snapshot) {
      throw new Error(`Profile ${profileId} references missing active version ${profile.activeVersionId}`);
    }
    return { profile, snapshot };
  }

  getSnapshot(versionId: ProfileVersionId): ProfileVersionSnapshot | null {
    return this.profiles.getVersion(versionId);
  }

  listVersions(profileId: ProfileId): ProfileVersionSnapshot[] {
    return this.profiles.listVersions(profileId);
  }

  createProfile(input: {
    name: string;
    content: ProfileContent;
    setAsDefault?: boolean;
  }): ProfileWithSnapshot {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error('档案名称不能为空');
    }

    return this.uow.runInTransaction(() => {
      const now = new Date().toISOString() as IsoTimestamp;
      const profileId = crypto.randomUUID() as ProfileId;
      const versionId = crypto.randomUUID() as ProfileVersionId;
      const contentHash = sha256Json(input.content);

      const profile: ProfileRecord = {
        id: profileId,
        name: trimmedName,
        activeVersionId: versionId,
        createdAt: now,
        updatedAt: now,
      };
      const snapshot: ProfileVersionSnapshot = {
        id: versionId,
        profileId,
        versionNumber: 1,
        content: structuredClone(input.content),
        contentHash,
        createdAt: now,
      };

      this.profiles.saveProfile(profile);
      this.profiles.saveVersion(snapshot);

      if (input.setAsDefault || this.getDefaultProfileId() === null) {
        this.preferences.set(DEFAULT_PROFILE_PREF_KEY, profileId, now);
      }

      return { profile, snapshot };
    });
  }

  /**
   * Updates structured profile content by creating a brand new immutable ProfileVersionSnapshot
   * whenever the canonical content hash changes. Existing application tasks remain pinned to
   * their original profileVersionId.
   */
  updateProfileContent(profileId: ProfileId, nextContent: ProfileContent): ProfileWithSnapshot {
    return this.uow.runInTransaction(() => {
      const existing = this.getProfileWithActiveVersion(profileId);
      if (!existing) {
        throw new Error(`档案不存在: ${profileId}`);
      }

      const nextHash = sha256Json(nextContent);
      if (existing.snapshot.contentHash === nextHash) {
        return existing;
      }

      const now = new Date().toISOString() as IsoTimestamp;
      const nextVersionNumber = this.profiles.getLatestVersionNumber(profileId) + 1;
      const nextVersionId = crypto.randomUUID() as ProfileVersionId;

      const snapshot: ProfileVersionSnapshot = {
        id: nextVersionId,
        profileId,
        versionNumber: nextVersionNumber,
        content: structuredClone(nextContent),
        contentHash: nextHash,
        createdAt: now,
      };
      const updatedProfile: ProfileRecord = {
        ...existing.profile,
        activeVersionId: nextVersionId,
        updatedAt: now,
      };

      this.profiles.saveVersion(snapshot);
      this.profiles.saveProfile(updatedProfile);

      return { profile: updatedProfile, snapshot };
    });
  }

  /**
   * Changing the default resume attachment does NOT modify structured profile content.
   */
  setDefaultResumeMaterial(profileId: ProfileId, materialId?: MaterialId): ProfileRecord {
    return this.uow.runInTransaction(() => {
      const profile = this.profiles.getProfile(profileId);
      if (!profile) {
        throw new Error(`档案不存在: ${profileId}`);
      }
      if (materialId) {
        const material = this.profiles.getMaterial(materialId);
        if (!material) {
          throw new Error(`材料不存在: ${materialId}`);
        }
      }
      const updated: ProfileRecord = {
        ...profile,
        defaultResumeMaterialId: materialId,
        updatedAt: new Date().toISOString() as IsoTimestamp,
      };
      this.profiles.saveProfile(updated);
      return updated;
    });
  }

  getDefaultProfileId(): ProfileId | null {
    const stored = this.preferences.get<string>(DEFAULT_PROFILE_PREF_KEY);
    if (stored) {
      const found = this.profiles.getProfile(stored as ProfileId);
      if (found) return found.id;
    }
    const all = this.profiles.listProfiles();
    return all[0]?.id ?? null;
  }

  setDefaultProfileId(profileId: ProfileId): void {
    const found = this.profiles.getProfile(profileId);
    if (!found) {
      throw new Error(`档案不存在，无法设为默认: ${profileId}`);
    }
    this.preferences.set(DEFAULT_PROFILE_PREF_KEY, profileId);
  }

  /**
   * Returns the current immutable version snapshot to lock onto a new application task.
   */
  createImmutableSnapshot(profileId: ProfileId): ProfileVersionSnapshot {
    const resolved = this.getProfileWithActiveVersion(profileId);
    if (!resolved) {
      throw new Error(`档案不存在: ${profileId}`);
    }
    return resolved.snapshot;
  }

  listFacts(profileId?: ProfileId): UserFactRecord[] {
    return this.profiles.listFacts(profileId);
  }

  rememberFact(input: {
    scope: 'global' | 'profile';
    profileId?: ProfileId;
    key: string;
    value: string;
    source: UserFactRecord['source'];
  }): UserFactRecord {
    const key = input.key.trim();
    const value = input.value.trim();
    if (!key || !value) {
      throw new Error('补充事实的键和值均不能为空');
    }
    if (input.scope === 'profile' && !input.profileId) {
      throw new Error('档案级事实必须指定 profileId');
    }

    return this.uow.runInTransaction(() => {
      const now = new Date().toISOString() as IsoTimestamp;
      const existing = this.profiles
        .listFacts(input.profileId)
        .find(
          (fact) =>
            fact.scope === input.scope &&
            (fact.profileId ?? null) === (input.scope === 'profile' ? input.profileId : null) &&
            fact.key === key,
        );

      const record: UserFactRecord = {
        id: existing?.id ?? crypto.randomUUID(),
        profileId: input.scope === 'profile' ? input.profileId : undefined,
        scope: input.scope,
        key,
        value,
        source: input.source,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.profiles.upsertFact(record);
      return record;
    });
  }
}
