import { JobHelperDatabase, type OpenDatabaseOptions } from './database.js';
import type {
  ActionLedgerRepository,
  ArtifactRepository,
  EventRepository,
  HumanInTheLoopRepository,
  PositionRepository,
  PreferencesRepository,
  ProfileRepository,
  ProviderRepository,
  RunRepository,
  SiteMemoryRepository,
  StorageUnitOfWork,
  TaskRepository,
} from './repositories.js';
import {
  SqliteActionLedgerRepository,
  SqliteArtifactRepository,
  SqliteHumanInTheLoopRepository,
  SqliteSiteMemoryRepository,
} from './sqlite/hitl-audit-repos.js';
import {
  SqlitePreferencesRepository,
  SqliteProviderRepository,
} from './sqlite/preferences-provider-repos.js';
import {
  SqlitePositionRepository,
  SqliteProfileRepository,
} from './sqlite/profile-position-repos.js';
import {
  SqliteEventRepository,
  SqliteRunRepository,
  SqliteTaskRepository,
} from './sqlite/task-run-event-repos.js';

export interface SqliteStorage {
  readonly db: JobHelperDatabase;
  readonly uow: StorageUnitOfWork;
  readonly preferences: PreferencesRepository;
  readonly providers: ProviderRepository;
  readonly profiles: ProfileRepository;
  readonly positions: PositionRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly hitl: HumanInTheLoopRepository;
  readonly actionLedger: ActionLedgerRepository;
  readonly artifacts: ArtifactRepository;
  readonly siteMemories: SiteMemoryRepository;
  close(): void;
}

export function createSqliteStorage(options: OpenDatabaseOptions): SqliteStorage {
  const db = JobHelperDatabase.open(options);
  return {
    db,
    uow: db,
    preferences: new SqlitePreferencesRepository(db),
    providers: new SqliteProviderRepository(db),
    profiles: new SqliteProfileRepository(db),
    positions: new SqlitePositionRepository(db),
    tasks: new SqliteTaskRepository(db),
    runs: new SqliteRunRepository(db),
    events: new SqliteEventRepository(db),
    hitl: new SqliteHumanInTheLoopRepository(db),
    actionLedger: new SqliteActionLedgerRepository(db),
    artifacts: new SqliteArtifactRepository(db),
    siteMemories: new SqliteSiteMemoryRepository(db),
    close: () => db.close(),
  };
}
