-- JobHelper Initial SQLite Schema Blueprint (v0.1)
-- Single Source of Truth for local tasks, four-axis states, events, profiles, confirmations, and action ledger.
-- Required runtime PRAGMAs:
--   PRAGMA journal_mode = WAL;
--   PRAGMA foreign_keys = ON;
--   PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- 1. BYOK Model Providers (NO plaintext API keys; credential_key -> safeStorage)
-- ============================================================================
CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai-compatible', 'anthropic', 'gemini')),
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  credential_key TEXT NOT NULL UNIQUE,
  timeout_ms INTEGER NOT NULL DEFAULT 60000 CHECK (timeout_ms > 0),
  max_context_tokens INTEGER NOT NULL DEFAULT 128000 CHECK (max_context_tokens > 0),
  custom_headers_json TEXT,
  capabilities_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- 2. Profiles, Immutable Version Snapshots, Materials, and Confirmed User Facts
-- ============================================================================
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active_version_id TEXT,
  default_resume_material_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  content_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, version_number)
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('resume_pdf', 'certificate', 'transcript', 'portfolio', 'photo', 'other')),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_facts (
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'profile')),
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user_edit', 'question_reply', 'agent_confirmed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- 3. Local Job Positions Tracker
-- ============================================================================
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  job_title TEXT NOT NULL,
  department TEXT,
  apply_url TEXT NOT NULL,
  normalized_apply_url TEXT NOT NULL,
  source_note TEXT,
  deadline_at TEXT,
  progress_stage TEXT NOT NULL DEFAULT 'saved' CHECK (
    progress_stage IN ('saved', 'in_progress', 'submitted_verified', 'submitted_user_reported', 'assessment', 'interview', 'offer', 'closed')
  ),
  closed_reason TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_positions_normalized_url ON positions(normalized_apply_url);

-- ============================================================================
-- 4. Tasks (Coordinator Conversations + Independent Application Tasks)
--    Strictly enforces the 4-axis state model via CHECK constraints.
-- ============================================================================
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('coordinator', 'application')),
  title TEXT NOT NULL,
  company TEXT,
  job_title TEXT,
  apply_url TEXT,
  normalized_apply_url TEXT,
  position_id TEXT REFERENCES positions(id) ON DELETE SET NULL,
  origin_conversation_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  profile_version_id TEXT REFERENCES profile_versions(id) ON DELETE RESTRICT,
  browser_profile_id TEXT NOT NULL DEFAULT 'default',
  control_mode TEXT NOT NULL DEFAULT 'human' CHECK (control_mode IN ('agent', 'stopping', 'human')),
  execution_state TEXT NOT NULL DEFAULT 'draft' CHECK (
    execution_state IN ('draft', 'queued', 'running', 'stopping', 'paused', 'waiting_user', 'interrupted', 'error', 'closed')
  ),
  waiting_reason TEXT NOT NULL DEFAULT 'none' CHECK (
    waiting_reason IN ('none', 'login', 'captcha', 'missing_info', 'manual_control', 'submission_confirmation', 'manual_submit', 'result_check')
  ),
  application_stage TEXT NOT NULL DEFAULT 'created' CHECK (
    application_stage IN ('created', 'opened', 'inspecting', 'filling', 'filling_ready', 'submit_attempted', 'verifying', 'done')
  ),
  outcome TEXT NOT NULL DEFAULT 'not_submitted' CHECK (
    outcome IN ('not_submitted', 'unknown', 'submitted_verified', 'user_reported', 'job_unavailable', 'closed_without_submit')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_kind_state ON tasks(kind, execution_state);
CREATE INDEX IF NOT EXISTS idx_tasks_active_url ON tasks(normalized_apply_url) WHERE kind = 'application' AND execution_state <> 'closed';
CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_conversation_id);

CREATE TABLE IF NOT EXISTS task_materials (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  authorized_at TEXT NOT NULL,
  PRIMARY KEY (task_id, material_id)
);

-- ============================================================================
-- 5. Runs, Ordered Events, Artifacts, Action Ledger
-- ============================================================================
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL UNIQUE,
  provider_snapshot_json TEXT NOT NULL,
  skill_catalog_version TEXT,
  end_reason TEXT CHECK (
    end_reason IS NULL OR end_reason IN ('completed', 'waiting_user', 'stopped_by_user', 'interrupted', 'model_error', 'browser_error', 'worker_crash')
  ),
  usage_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  epoch TEXT,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'user_message', 'assistant_message', 'tool_call', 'tool_result',
      'status_transition', 'todo_updated', 'question_asked', 'question_answered',
      'confirmation_updated', 'system_notice'
    )
  ),
  client_message_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_client_msg
  ON task_events(task_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'confirmation_screenshot', 'receipt_screenshot', 'spill_text', 'network_log')),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_ledger (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  call_id TEXT,
  action_type TEXT NOT NULL,
  target_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'observed', 'failed', 'unknown')),
  readback_summary TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_ledger_task ON action_ledger(task_id, created_at);

-- ============================================================================
-- 6. Human-in-the-Loop Cards: Todos, Questions (callId+questionId), Confirmations
-- ============================================================================
CREATE TABLE IF NOT EXISTS task_todos (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('login', 'captcha', 'missing_info', 'manual_control', 'submission_confirmation', 'manual_submit', 'result_check')
  ),
  summary TEXT NOT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS task_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'expired_pending', 'cancelled')),
  answers_json TEXT,
  reply_injected_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_questions_call ON task_questions(task_id, call_id);

CREATE TABLE IF NOT EXISTS task_confirmations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('final_submit', 'save_draft', 'irreversible_step')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'invalidated', 'consumed', 'expired')),
  content_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_confirmations_task_status ON task_confirmations(task_id, status);

-- ============================================================================
-- 7. Local Site Memories & Skill Drafts (Offline-First Knowledge Evolution)
-- ============================================================================
CREATE TABLE IF NOT EXISTS site_memories (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_memories_domain ON site_memories(domain);

CREATE TABLE IF NOT EXISTS skill_drafts (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  diff_or_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
