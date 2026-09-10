-- Environment & resources: project settings, per-worktree environment state, ports, DB forks, services.

ALTER TABLE projects ADD COLUMN settings_json TEXT;

ALTER TABLE worktrees ADD COLUMN env_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE worktrees ADD COLUMN env_state_reason TEXT;
ALTER TABLE worktrees ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'stopped';
ALTER TABLE worktrees ADD COLUMN options_json TEXT;
ALTER TABLE worktrees ADD COLUMN env_json TEXT;
ALTER TABLE worktrees ADD COLUMN provisioned_at INTEGER;

-- One row per named port a worktree holds; ports are unique daemon-wide.
CREATE TABLE port_allocations (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  port        INTEGER NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, name)
);

-- Database forks, one per (worktree, database name).
CREATE TABLE db_instances (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  adapter     TEXT NOT NULL,
  status      TEXT NOT NULL,
  url         TEXT,
  forked_from TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  size_mb     REAL,
  seeded_at   INTEGER,
  error       TEXT,
  PRIMARY KEY (worktree_id, name)
);

-- Last known process/container per service, for kill-and-respawn on daemon boot.
CREATE TABLE service_state (
  worktree_id     TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  runtime         TEXT NOT NULL,
  pid             INTEGER,
  pid_start       INTEGER,
  container_id    TEXT,
  compose_project TEXT,
  restarts        INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, name)
);

-- Provisioning runs (latest per worktree is what the UI shows; history kept for debugging).
CREATE TABLE provision_runs (
  id          TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  steps_json  TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX provision_runs_wt ON provision_runs (worktree_id, started_at);

-- Seed templates already built, per project + database (adapter-specific detail).
CREATE TABLE db_templates (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  adapter     TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  seeded_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
