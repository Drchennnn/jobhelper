import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { StorageUnitOfWork } from './repositories.js';

export interface OpenDatabaseOptions {
  /** File path or ':memory:' for in-memory tests. */
  filename: string;
  /** Optional override for SQL migrations directory; defaults to package migrations/. */
  migrationsDir?: string;
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export class JobHelperDatabase implements StorageUnitOfWork {
  readonly sqlite: DatabaseSync;
  private txDepth = 0;

  private constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  static open(options: OpenDatabaseOptions): JobHelperDatabase {
    const isMemory = options.filename === ':memory:';
    if (!isMemory) {
      fs.mkdirSync(path.dirname(path.resolve(options.filename)), { recursive: true });
    }

    const sqlite = new DatabaseSync(options.filename);
    try {
      if (!isMemory) {
        sqlite.exec('PRAGMA journal_mode = WAL;');
      }
      sqlite.exec('PRAGMA foreign_keys = ON;');
      sqlite.exec('PRAGMA busy_timeout = 5000;');

      const db = new JobHelperDatabase(sqlite);
      db.applyMigrations(options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
      return db;
    } catch (error) {
      sqlite.close();
      throw error;
    }
  }

  runInTransaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    if (depth === 0) {
      this.sqlite.exec('BEGIN IMMEDIATE');
    } else {
      this.sqlite.exec(`SAVEPOINT sp_${depth}`);
    }
    this.txDepth = depth + 1;

    try {
      const result = fn();
      this.txDepth = depth;
      if (depth === 0) {
        this.sqlite.exec('COMMIT');
      } else {
        this.sqlite.exec(`RELEASE SAVEPOINT sp_${depth}`);
      }
      return result;
    } catch (error) {
      this.txDepth = depth;
      if (depth === 0) {
        this.sqlite.exec('ROLLBACK');
      } else {
        this.sqlite.exec(`ROLLBACK TO SAVEPOINT sp_${depth}`);
        this.sqlite.exec(`RELEASE SAVEPOINT sp_${depth}`);
      }
      throw error;
    }
  }

  applyMigrations(migrationsDir: string): string[] {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found: ${migrationsDir}`);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    const appliedRows = this.sqlite
      .prepare('SELECT version, checksum FROM schema_migrations')
      .all() as Array<{ version: string; checksum: string }>;
    const appliedMap = new Map(appliedRows.map((row) => [row.version, row.checksum]));

    const newlyApplied: string[] = [];
    const insertMigration = this.sqlite.prepare(
      'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
    );

    for (const file of files) {
      const version = file.replace(/\.sql$/i, '');
      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      const existingChecksum = appliedMap.get(version);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${version}: expected ${existingChecksum}, got ${checksum}`,
          );
        }
        continue;
      }

      this.runInTransaction(() => {
        this.sqlite.exec(sql);
        insertMigration.run(version, checksum, new Date().toISOString());
      });
      newlyApplied.push(version);
    }

    return newlyApplied;
  }

  close(): void {
    this.sqlite.close();
  }
}
