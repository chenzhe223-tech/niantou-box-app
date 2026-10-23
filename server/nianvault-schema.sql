-- NianVault archive queue — additive migration for the existing nianbox-cloud D1.
-- This file is NOT automatically applied by the current deploy script yet.
-- Apply only after review and wire it into a versioned migration/deployment step.
-- No idea rows are copied by this migration.

CREATE TABLE IF NOT EXISTS vault_settings (
  user_id TEXT PRIMARY KEY,
  enabled_at INTEGER NOT NULL,
  activation_seq INTEGER NOT NULL DEFAULT 0,
  repository TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_archive_jobs (
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('idea', 'project')),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'soft_delete', 'restore')),
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retrying', 'archived', 'conflict', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  github_path TEXT,
  github_commit_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  PRIMARY KEY (user_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_vault_jobs_due
  ON vault_archive_jobs (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_vault_jobs_entity
  ON vault_archive_jobs (user_id, entity, entity_id, entity_version);

CREATE INDEX IF NOT EXISTS idx_vault_jobs_user_status
  ON vault_archive_jobs (user_id, status, created_at);

CREATE TABLE IF NOT EXISTS vault_entity_heads (
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('idea', 'project')),
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  github_path TEXT NOT NULL,
  github_blob_sha TEXT,
  github_commit_sha TEXT,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity, entity_id)
);

CREATE TABLE IF NOT EXISTS vault_audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- No idea body, token, password, or request payload in audit logs.
  detail_code TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_vault_audit_user_time
  ON vault_audit_events (user_id, created_at);
