import type {
  ApplicationOutcome,
  ApplicationStage,
  BrowserControlMode,
  BrowserProfileId,
  ClientMessageId,
  Epoch,
  EventId,
  ExecutionState,
  IsoTimestamp,
  MaterialId,
  ModelUsage,
  PositionId,
  ProfileVersionId,
  RunEndReason,
  RunId,
  RunModelSnapshot,
  TaskEventRecord,
  TaskEventType,
  TaskId,
  TaskKind,
  TaskRecord,
  TaskRunRecord,
  WaitingReason,
} from '@jobhelper/contracts';
import type { JobHelperDatabase } from '../database.js';
import type { EventRepository, RunRepository, TaskRepository } from '../repositories.js';

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  company: string | null;
  job_title: string | null;
  apply_url: string | null;
  normalized_apply_url: string | null;
  position_id: string | null;
  origin_conversation_id: string | null;
  profile_version_id: string | null;
  browser_profile_id: string;
  control_mode: string;
  execution_state: string;
  waiting_reason: string;
  application_stage: string;
  outcome: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  epoch: string;
  provider_snapshot_json: string;
  skill_catalog_version: string | null;
  end_reason: string | null;
  usage_json: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

interface EventRow {
  id: string;
  task_id: string;
  run_id: string | null;
  epoch: string | null;
  seq: number;
  event_type: string;
  client_message_id: string | null;
  payload_json: string;
  created_at: string;
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id as TaskId,
    kind: row.kind as TaskKind,
    title: row.title,
    company: row.company ?? undefined,
    jobTitle: row.job_title ?? undefined,
    applyUrl: row.apply_url ?? undefined,
    normalizedApplyUrl: row.normalized_apply_url ?? undefined,
    positionId: row.position_id ? (row.position_id as PositionId) : undefined,
    originConversationId: row.origin_conversation_id
      ? (row.origin_conversation_id as TaskId)
      : undefined,
    profileVersionId: row.profile_version_id
      ? (row.profile_version_id as ProfileVersionId)
      : undefined,
    browserProfileId: row.browser_profile_id as BrowserProfileId,
    controlMode: row.control_mode as BrowserControlMode,
    executionState: row.execution_state as ExecutionState,
    waitingReason: row.waiting_reason as WaitingReason,
    applicationStage: row.application_stage as ApplicationStage,
    outcome: row.outcome as ApplicationOutcome,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
    closedAt: row.closed_at ? (row.closed_at as IsoTimestamp) : undefined,
  };
}

function mapRun(row: RunRow): TaskRunRecord {
  return {
    id: row.id as RunId,
    taskId: row.task_id as TaskId,
    epoch: row.epoch as Epoch,
    providerSnapshot: JSON.parse(row.provider_snapshot_json) as RunModelSnapshot,
    skillCatalogVersion: row.skill_catalog_version ?? undefined,
    endReason: row.end_reason ? (row.end_reason as RunEndReason) : undefined,
    usage: row.usage_json ? (JSON.parse(row.usage_json) as ModelUsage) : undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    startedAt: row.started_at as IsoTimestamp,
    finishedAt: row.finished_at ? (row.finished_at as IsoTimestamp) : undefined,
  };
}

function mapEvent<TPayload = Record<string, unknown>>(row: EventRow): TaskEventRecord<TPayload> {
  return {
    id: row.id as EventId,
    taskId: row.task_id as TaskId,
    runId: row.run_id ? (row.run_id as RunId) : undefined,
    epoch: row.epoch ? (row.epoch as Epoch) : undefined,
    seq: row.seq,
    type: row.event_type as TaskEventType,
    clientMessageId: row.client_message_id ? (row.client_message_id as ClientMessageId) : undefined,
    payload: JSON.parse(row.payload_json) as TPayload,
    createdAt: row.created_at as IsoTimestamp,
  };
}

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  getById(taskId: TaskId): TaskRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  findActiveApplicationByUrl(normalizedUrl: string): TaskRecord | null {
    const row = this.db.sqlite
      .prepare(
        `SELECT * FROM tasks
         WHERE kind = 'application'
           AND normalized_apply_url = ?
           AND execution_state <> 'closed'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(normalizedUrl) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  listAll(): TaskRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM tasks ORDER BY updated_at DESC')
      .all() as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  insert(task: TaskRecord, authorizedMaterialIds?: readonly MaterialId[]): void {
    this.db.runInTransaction(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO tasks (
             id, kind, title, company, job_title, apply_url, normalized_apply_url,
             position_id, origin_conversation_id, profile_version_id, browser_profile_id,
             control_mode, execution_state, waiting_reason, application_stage, outcome,
             created_at, updated_at, closed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.kind,
          task.title,
          task.company ?? null,
          task.jobTitle ?? null,
          task.applyUrl ?? null,
          task.normalizedApplyUrl ?? null,
          task.positionId ?? null,
          task.originConversationId ?? null,
          task.profileVersionId ?? null,
          task.browserProfileId,
          task.controlMode,
          task.executionState,
          task.waitingReason,
          task.applicationStage,
          task.outcome,
          task.createdAt,
          task.updatedAt,
          task.closedAt ?? null,
        );

      if (authorizedMaterialIds && authorizedMaterialIds.length > 0) {
        const stmt = this.db.sqlite.prepare(
          'INSERT INTO task_materials (task_id, material_id, authorized_at) VALUES (?, ?, ?)',
        );
        for (const materialId of authorizedMaterialIds) {
          stmt.run(task.id, materialId, task.createdAt);
        }
      }
    });
  }

  update(task: TaskRecord): void {
    this.db.sqlite
      .prepare(
        `UPDATE tasks SET
           title = ?,
           company = ?,
           job_title = ?,
           apply_url = ?,
           normalized_apply_url = ?,
           position_id = ?,
           profile_version_id = ?,
           browser_profile_id = ?,
           control_mode = ?,
           execution_state = ?,
           waiting_reason = ?,
           application_stage = ?,
           outcome = ?,
           updated_at = ?,
           closed_at = ?
         WHERE id = ?`,
      )
      .run(
        task.title,
        task.company ?? null,
        task.jobTitle ?? null,
        task.applyUrl ?? null,
        task.normalizedApplyUrl ?? null,
        task.positionId ?? null,
        task.profileVersionId ?? null,
        task.browserProfileId,
        task.controlMode,
        task.executionState,
        task.waitingReason,
        task.applicationStage,
        task.outcome,
        task.updatedAt,
        task.closedAt ?? null,
        task.id,
      );
  }

  listAuthorizedMaterialIds(taskId: TaskId): MaterialId[] {
    const rows = this.db.sqlite
      .prepare('SELECT material_id FROM task_materials WHERE task_id = ? ORDER BY authorized_at ASC')
      .all(taskId) as Array<{ material_id: string }>;
    return rows.map((r) => r.material_id as MaterialId);
  }

  setAuthorizedMaterials(
    taskId: TaskId,
    materialIds: readonly MaterialId[],
    authorizedAt = new Date().toISOString(),
  ): void {
    this.db.runInTransaction(() => {
      this.db.sqlite.prepare('DELETE FROM task_materials WHERE task_id = ?').run(taskId);
      const stmt = this.db.sqlite.prepare(
        'INSERT INTO task_materials (task_id, material_id, authorized_at) VALUES (?, ?, ?)',
      );
      for (const materialId of materialIds) {
        stmt.run(taskId, materialId, authorizedAt);
      }
    });
  }

  recoverInterruptedTasksOnStartup(nowIso: string): TaskId[] {
    return this.db.runInTransaction(() => {
      const affected = this.db.sqlite
        .prepare(
          `SELECT id FROM tasks
           WHERE execution_state IN ('running', 'queued', 'stopping')`,
        )
        .all() as Array<{ id: string }>;

      if (affected.length === 0) return [];

      this.db.sqlite
        .prepare(
          `UPDATE tasks
           SET execution_state = 'interrupted',
               control_mode = 'human',
               updated_at = ?
           WHERE execution_state IN ('running', 'queued', 'stopping')`,
        )
        .run(nowIso);

      this.db.sqlite
        .prepare(
          `UPDATE task_runs
           SET end_reason = 'interrupted',
               finished_at = ?
           WHERE finished_at IS NULL`,
        )
        .run(nowIso);

      return affected.map((row) => row.id as TaskId);
    });
  }
}

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  create(run: TaskRunRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO task_runs (
           id, task_id, epoch, provider_snapshot_json, skill_catalog_version,
           end_reason, usage_json, error_code, error_message, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.epoch,
        JSON.stringify(run.providerSnapshot),
        run.skillCatalogVersion ?? null,
        run.endReason ?? null,
        run.usage ? JSON.stringify(run.usage) : null,
        run.errorCode ?? null,
        run.errorMessage ?? null,
        run.startedAt,
        run.finishedAt ?? null,
      );
  }

  getById(runId: RunId): TaskRunRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM task_runs WHERE id = ?')
      .get(runId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  getByEpoch(epoch: Epoch): TaskRunRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM task_runs WHERE epoch = ?')
      .get(epoch) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listByTask(taskId: TaskId): TaskRunRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at ASC')
      .all(taskId) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  finish(
    runId: RunId,
    details: {
      endReason: RunEndReason;
      finishedAt: string;
      usage?: ModelUsage;
      errorCode?: string;
      errorMessage?: string;
    },
  ): void {
    this.db.sqlite
      .prepare(
        `UPDATE task_runs
         SET end_reason = ?,
             finished_at = ?,
             usage_json = COALESCE(?, usage_json),
             error_code = COALESCE(?, error_code),
             error_message = COALESCE(?, error_message)
         WHERE id = ?`,
      )
      .run(
        details.endReason,
        details.finishedAt,
        details.usage ? JSON.stringify(details.usage) : null,
        details.errorCode ?? null,
        details.errorMessage ?? null,
        runId,
      );
  }
}

export class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  append<TPayload = Record<string, unknown>>(
    event: Omit<TaskEventRecord<TPayload>, 'seq'>,
  ): TaskEventRecord<TPayload> {
    return this.db.runInTransaction(() => {
      const row = this.db.sqlite
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM task_events WHERE task_id = ?')
        .get(event.taskId) as { next_seq: number };
      const seq = row.next_seq;

      this.db.sqlite
        .prepare(
          `INSERT INTO task_events (
             id, task_id, run_id, epoch, seq, event_type, client_message_id, payload_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.taskId,
          event.runId ?? null,
          event.epoch ?? null,
          seq,
          event.type,
          event.clientMessageId ?? null,
          JSON.stringify(event.payload),
          event.createdAt,
        );

      return { ...event, seq };
    });
  }

  hasClientMessage(taskId: TaskId, clientMessageId: ClientMessageId): boolean {
    const row = this.db.sqlite
      .prepare(
        'SELECT 1 AS found FROM task_events WHERE task_id = ? AND client_message_id = ? LIMIT 1',
      )
      .get(taskId, clientMessageId) as { found: number } | undefined;
    return row !== undefined;
  }

  listByTask(taskId: TaskId, afterSeq = 0): TaskEventRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC')
      .all(taskId, afterSeq) as unknown as EventRow[];
    return rows.map((row) => mapEvent(row));
  }
}
