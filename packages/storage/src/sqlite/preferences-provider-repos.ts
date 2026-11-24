import type {
  IsoTimestamp,
  ModelCapabilities,
  ModelProviderConfig,
  ModelProviderType,
  ProviderId,
} from '@jobhelper/contracts';
import type { JobHelperDatabase } from '../database.js';
import type { PreferencesRepository, ProviderRepository } from '../repositories.js';

interface ProviderRow {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  model_id: string;
  credential_key: string;
  timeout_ms: number;
  max_context_tokens: number;
  custom_headers_json: string | null;
  capabilities_json: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function mapProvider(row: ProviderRow): ModelProviderConfig {
  return {
    id: row.id as ProviderId,
    name: row.name,
    providerType: row.provider_type as ModelProviderType,
    baseUrl: row.base_url,
    modelId: row.model_id,
    credentialKey: row.credential_key,
    timeoutMs: row.timeout_ms,
    maxContextTokens: row.max_context_tokens,
    customHeaders: row.custom_headers_json
      ? (JSON.parse(row.custom_headers_json) as Record<string, string>)
      : undefined,
    capabilities: JSON.parse(row.capabilities_json) as ModelCapabilities,
    isDefault: row.is_default === 1,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

export class SqlitePreferencesRepository implements PreferencesRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  get<T = unknown>(key: string): T | null {
    const row = this.db.sqlite
      .prepare('SELECT value_json FROM app_preferences WHERE key = ?')
      .get(key) as { value_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value_json) as T;
  }

  set(key: string, value: unknown, updatedAt = new Date().toISOString()): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO app_preferences (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), updatedAt);
  }

  delete(key: string): void {
    this.db.sqlite.prepare('DELETE FROM app_preferences WHERE key = ?').run(key);
  }
}

export class SqliteProviderRepository implements ProviderRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  list(): ModelProviderConfig[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM model_providers ORDER BY is_default DESC, created_at ASC')
      .all() as unknown as ProviderRow[];
    return rows.map(mapProvider);
  }

  getById(id: ProviderId): ModelProviderConfig | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM model_providers WHERE id = ?')
      .get(id) as ProviderRow | undefined;
    return row ? mapProvider(row) : null;
  }

  getDefault(): ModelProviderConfig | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM model_providers WHERE is_default = 1 LIMIT 1')
      .get() as ProviderRow | undefined;
    return row ? mapProvider(row) : null;
  }

  upsert(config: ModelProviderConfig): void {
    this.db.runInTransaction(() => {
      if (config.isDefault) {
        this.db.sqlite
          .prepare('UPDATE model_providers SET is_default = 0 WHERE id <> ?')
          .run(config.id);
      }
      this.db.sqlite
        .prepare(
          `INSERT INTO model_providers (
            id, name, provider_type, base_url, model_id, credential_key,
            timeout_ms, max_context_tokens, custom_headers_json, capabilities_json,
            is_default, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            provider_type = excluded.provider_type,
            base_url = excluded.base_url,
            model_id = excluded.model_id,
            credential_key = excluded.credential_key,
            timeout_ms = excluded.timeout_ms,
            max_context_tokens = excluded.max_context_tokens,
            custom_headers_json = excluded.custom_headers_json,
            capabilities_json = excluded.capabilities_json,
            is_default = excluded.is_default,
            updated_at = excluded.updated_at`,
        )
        .run(
          config.id,
          config.name,
          config.providerType,
          config.baseUrl,
          config.modelId,
          config.credentialKey,
          config.timeoutMs,
          config.maxContextTokens,
          config.customHeaders ? JSON.stringify(config.customHeaders) : null,
          JSON.stringify(config.capabilities),
          config.isDefault ? 1 : 0,
          config.createdAt,
          config.updatedAt,
        );
    });
  }

  delete(id: ProviderId): void {
    this.db.sqlite.prepare('DELETE FROM model_providers WHERE id = ?').run(id);
  }
}
