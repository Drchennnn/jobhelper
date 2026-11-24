import type {
  ActionLedgerRecord,
  ArtifactId,
  ArtifactKind,
  ArtifactRecord,
  CallId,
  ConfirmationCardRecord,
  ConfirmationId,
  ConfirmationOperation,
  ConfirmationStatus,
  ContentHash,
  Epoch,
  IsoTimestamp,
  QuestionCardRecord,
  QuestionCardStatus,
  QuestionItem,
  RunId,
  SiteMemoryRecord,
  SkillDraftRecord,
  TaskId,
  TodoCardRecord,
  TodoId,
  WaitingReason,
} from '@jobhelper/contracts';
import type { JobHelperDatabase } from '../database.js';
import type {
  ActionLedgerRepository,
  ArtifactRepository,
  HumanInTheLoopRepository,
  SiteMemoryRepository,
} from '../repositories.js';

interface TodoRow {
  id: string;
  task_id: string;
  run_id: string | null;
  reason: string;
  summary: string;
  instructions: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

interface QuestionRow {
  id: string;
  task_id: string;
  run_id: string;
  call_id: string;
  questions_json: string;
  status: string;
  answers_json: string | null;
  reply_injected_run_id: string | null;
  created_at: string;
  answered_at: string | null;
}

interface ConfirmationRow {
  id: string;
  task_id: string;
  run_id: string;
  operation: string;
  status: string;
  content_hash: string;
  summary_json: string;
  created_at: string;
  resolved_at: string | null;
}

interface ActionLedgerRow {
  id: string;
  task_id: string;
  run_id: string;
  epoch: string;
  call_id: string | null;
  action_type: string;
  target_summary: string;
  status: string;
  readback_summary: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  relative_path: string;
  label: string | null;
  created_at: string;
}

interface SiteMemoryRow {
  id: string;
  domain: string;
  title: string;
  content: string;
  verified: number;
  created_at: string;
  updated_at: string;
}

interface SkillDraftRow {
  id: string;
  skill_name: string;
  source_task_id: string | null;
  diff_or_content: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
}

function mapTodo(row: TodoRow): TodoCardRecord {
  return {
    id: row.id as TodoId,
    taskId: row.task_id as TaskId,
    runId: row.run_id ? (row.run_id as RunId) : undefined,
    reason: row.reason as WaitingReason,
    summary: row.summary,
    instructions: row.instructions,
    status: row.status as TodoCardRecord['status'],
    createdAt: row.created_at as IsoTimestamp,
    resolvedAt: row.resolved_at ? (row.resolved_at as IsoTimestamp) : undefined,
  };
}

function mapQuestion(row: QuestionRow): QuestionCardRecord {
  return {
    id: row.id,
    taskId: row.task_id as TaskId,
    runId: row.run_id as RunId,
    callId: row.call_id as CallId,
    questions: JSON.parse(row.questions_json) as QuestionItem[],
    status: row.status as QuestionCardStatus,
    answers: row.answers_json
      ? (JSON.parse(row.answers_json) as NonNullable<QuestionCardRecord['answers']>)
      : undefined,
    createdAt: row.created_at as IsoTimestamp,
    answeredAt: row.answered_at ? (row.answered_at as IsoTimestamp) : undefined,
  };
}

function mapConfirmation(row: ConfirmationRow): ConfirmationCardRecord {
  return {
    id: row.id as ConfirmationId,
    taskId: row.task_id as TaskId,
    runId: row.run_id as RunId,
    operation: row.operation as ConfirmationOperation,
    status: row.status as ConfirmationStatus,
    contentHash: row.content_hash as ContentHash,
    summary: JSON.parse(row.summary_json) as ConfirmationCardRecord['summary'],
    createdAt: row.created_at as IsoTimestamp,
    resolvedAt: row.resolved_at ? (row.resolved_at as IsoTimestamp) : undefined,
  };
}

function mapAction(row: ActionLedgerRow): ActionLedgerRecord {
  return {
    id: row.id,
    taskId: row.task_id as TaskId,
    runId: row.run_id as RunId,
    epoch: row.epoch as Epoch,
    callId: row.call_id ? (row.call_id as CallId) : undefined,
    actionType: row.action_type,
    targetSummary: row.target_summary,
    status: row.status as ActionLedgerRecord['status'],
    readbackSummary: row.readback_summary ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id as ArtifactId,
    taskId: row.task_id as TaskId,
    runId: row.run_id ? (row.run_id as RunId) : undefined,
    kind: row.kind as ArtifactKind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256 as ContentHash,
    relativePath: row.relative_path,
    label: row.label ?? undefined,
    createdAt: row.created_at as IsoTimestamp,
  };
}

export class SqliteHumanInTheLoopRepository implements HumanInTheLoopRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  saveTodo(todo: TodoCardRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO task_todos (id, task_id, run_id, reason, summary, instructions, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           instructions = excluded.instructions,
           status = excluded.status,
           resolved_at = excluded.resolved_at`,
      )
      .run(
        todo.id,
        todo.taskId,
        todo.runId ?? null,
        todo.reason,
        todo.summary,
        todo.instructions,
        todo.status,
        todo.createdAt,
        todo.resolvedAt ?? null,
      );
  }

  getOpenTodo(taskId: TaskId): TodoCardRecord | null {
    const row = this.db.sqlite
      .prepare(
        `SELECT * FROM task_todos
         WHERE task_id = ? AND status = 'open'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as TodoRow | undefined;
    return row ? mapTodo(row) : null;
  }

  resolveTodo(id: TodoId, status: 'resolved' | 'cancelled', resolvedAt: string): void {
    this.db.sqlite
      .prepare('UPDATE task_todos SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, resolvedAt, id);
  }

  saveQuestionCard(card: QuestionCardRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO task_questions (
           id, task_id, run_id, call_id, questions_json, status, answers_json, created_at, answered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           answers_json = excluded.answers_json,
           answered_at = excluded.answered_at`,
      )
      .run(
        card.id,
        card.taskId,
        card.runId,
        card.callId,
        JSON.stringify(card.questions),
        card.status,
        card.answers ? JSON.stringify(card.answers) : null,
        card.createdAt,
        card.answeredAt ?? null,
      );
  }

  getQuestionCard(id: string): QuestionCardRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM task_questions WHERE id = ?')
      .get(id) as QuestionRow | undefined;
    return row ? mapQuestion(row) : null;
  }

  getQuestionCardByCallId(taskId: TaskId, callId: CallId): QuestionCardRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM task_questions WHERE task_id = ? AND call_id = ? LIMIT 1')
      .get(taskId, callId) as QuestionRow | undefined;
    return row ? mapQuestion(row) : null;
  }

  getPendingQuestionCard(taskId: TaskId): QuestionCardRecord | null {
    const row = this.db.sqlite
      .prepare(
        `SELECT * FROM task_questions
         WHERE task_id = ? AND status IN ('pending', 'expired_pending')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as QuestionRow | undefined;
    return row ? mapQuestion(row) : null;
  }

  recordQuestionAnswers(
    id: string,
    answers: NonNullable<QuestionCardRecord['answers']>,
    answeredAt: string,
  ): void {
    this.db.sqlite
      .prepare(
        `UPDATE task_questions
         SET status = 'answered', answers_json = ?, answered_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(answers), answeredAt, id);
  }

  markQuestionReplyInjected(id: string, runId: RunId): void {
    this.db.sqlite
      .prepare('UPDATE task_questions SET reply_injected_run_id = ? WHERE id = ?')
      .run(runId, id);
  }

  saveConfirmation(card: ConfirmationCardRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO task_confirmations (
           id, task_id, run_id, operation, status, content_hash, summary_json, created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           summary_json = excluded.summary_json,
           resolved_at = excluded.resolved_at`,
      )
      .run(
        card.id,
        card.taskId,
        card.runId,
        card.operation,
        card.status,
        card.contentHash,
        JSON.stringify(card.summary),
        card.createdAt,
        card.resolvedAt ?? null,
      );
  }

  getConfirmation(id: ConfirmationId): ConfirmationCardRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM task_confirmations WHERE id = ?')
      .get(id) as ConfirmationRow | undefined;
    return row ? mapConfirmation(row) : null;
  }

  getActiveConfirmation(taskId: TaskId): ConfirmationCardRecord | null {
    const row = this.db.sqlite
      .prepare(
        `SELECT * FROM task_confirmations
         WHERE task_id = ? AND status IN ('pending', 'approved')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as ConfirmationRow | undefined;
    return row ? mapConfirmation(row) : null;
  }

  updateConfirmationStatus(id: ConfirmationId, status: ConfirmationStatus, resolvedAt: string): void {
    this.db.sqlite
      .prepare('UPDATE task_confirmations SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, resolvedAt, id);
  }

  invalidateConfirmations(taskId: TaskId, _reason: string, nowIso: string): number {
    const result = this.db.sqlite
      .prepare(
        `UPDATE task_confirmations
         SET status = 'invalidated', resolved_at = ?
         WHERE task_id = ? AND status IN ('pending', 'approved')`,
      )
      .run(nowIso, taskId);
    return Number(result.changes);
  }

  verifyContentHashMatches(id: ConfirmationId, expectedHash: ContentHash): boolean {
    const row = this.db.sqlite
      .prepare('SELECT content_hash, status FROM task_confirmations WHERE id = ?')
      .get(id) as { content_hash: string; status: string } | undefined;
    if (!row) return false;
    return row.content_hash === expectedHash && (row.status === 'pending' || row.status === 'approved');
  }
}

export class SqliteActionLedgerRepository implements ActionLedgerRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  record(entry: ActionLedgerRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO action_ledger (
           id, task_id, run_id, epoch, call_id, action_type, target_summary,
           status, readback_summary, error_message, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.taskId,
        entry.runId,
        entry.epoch,
        entry.callId ?? null,
        entry.actionType,
        entry.targetSummary,
        entry.status,
        entry.readbackSummary ?? null,
        entry.errorMessage ?? null,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  updateStatus(
    id: string,
    status: ActionLedgerRecord['status'],
    details?: { readbackSummary?: string; errorMessage?: string; updatedAt: string },
  ): void {
    const updatedAt = details?.updatedAt ?? new Date().toISOString();
    this.db.sqlite
      .prepare(
        `UPDATE action_ledger
         SET status = ?,
             readback_summary = COALESCE(?, readback_summary),
             error_message = COALESCE(?, error_message),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(status, details?.readbackSummary ?? null, details?.errorMessage ?? null, updatedAt, id);
  }

  listByRun(runId: RunId): ActionLedgerRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM action_ledger WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as unknown as ActionLedgerRow[];
    return rows.map(mapAction);
  }

  listByTask(taskId: TaskId): ActionLedgerRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM action_ledger WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as unknown as ActionLedgerRow[];
    return rows.map(mapAction);
  }
}

export class SqliteArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  save(artifact: ArtifactRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO artifacts (
           id, task_id, run_id, kind, mime_type, size_bytes, sha256, relative_path, label, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.taskId,
        artifact.runId ?? null,
        artifact.kind,
        artifact.mimeType,
        artifact.sizeBytes,
        artifact.sha256,
        artifact.relativePath,
        artifact.label ?? null,
        artifact.createdAt,
      );
  }

  getById(id: ArtifactId): ArtifactRecord | null {
    const row = this.db.sqlite
      .prepare('SELECT * FROM artifacts WHERE id = ?')
      .get(id) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  listByTask(taskId: TaskId): ArtifactRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as unknown as ArtifactRow[];
    return rows.map(mapArtifact);
  }
}

export class SqliteSiteMemoryRepository implements SiteMemoryRepository {
  constructor(private readonly db: JobHelperDatabase) {}

  listByDomain(domain: string): SiteMemoryRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM site_memories WHERE domain = ? ORDER BY verified DESC, updated_at DESC')
      .all(domain) as unknown as SiteMemoryRow[];
    return rows.map((row) => ({
      id: row.id,
      domain: row.domain,
      title: row.title,
      content: row.content,
      verified: row.verified === 1,
      createdAt: row.created_at as IsoTimestamp,
      updatedAt: row.updated_at as IsoTimestamp,
    }));
  }

  upsert(memory: SiteMemoryRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO site_memories (id, domain, title, content, verified, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           domain = excluded.domain,
           title = excluded.title,
           content = excluded.content,
           verified = excluded.verified,
           updated_at = excluded.updated_at`,
      )
      .run(
        memory.id,
        memory.domain,
        memory.title,
        memory.content,
        memory.verified ? 1 : 0,
        memory.createdAt,
        memory.updatedAt,
      );
  }

  saveSkillDraft(draft: SkillDraftRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO skill_drafts (id, skill_name, source_task_id, diff_or_content, status, created_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.id,
        draft.skillName,
        draft.sourceTaskId ?? null,
        draft.diffOrContent,
        draft.status,
        draft.createdAt,
        draft.reviewedAt ?? null,
      );
  }

  listSkillDrafts(status?: SkillDraftRecord['status']): SkillDraftRecord[] {
    const rows = status
      ? (this.db.sqlite
          .prepare('SELECT * FROM skill_drafts WHERE status = ? ORDER BY created_at DESC')
          .all(status) as unknown as SkillDraftRow[])
      : (this.db.sqlite
          .prepare('SELECT * FROM skill_drafts ORDER BY created_at DESC')
          .all() as unknown as SkillDraftRow[]);
    return rows.map((row) => ({
      id: row.id,
      skillName: row.skill_name,
      sourceTaskId: row.source_task_id ? (row.source_task_id as TaskId) : undefined,
      diffOrContent: row.diff_or_content,
      status: row.status as SkillDraftRecord['status'],
      createdAt: row.created_at as IsoTimestamp,
      reviewedAt: row.reviewed_at ? (row.reviewed_at as IsoTimestamp) : undefined,
    }));
  }

  reviewSkillDraft(id: string, status: 'approved' | 'rejected', reviewedAt: string): void {
    this.db.sqlite
      .prepare('UPDATE skill_drafts SET status = ?, reviewed_at = ? WHERE id = ?')
      .run(status, reviewedAt, id);
  }
}
