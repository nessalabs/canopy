CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL UNIQUE,
  default_base  TEXT NOT NULL,
  config_yaml   TEXT,
  detected_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE worktrees (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  branch      TEXT,
  base_branch TEXT,
  is_main     INTEGER NOT NULL DEFAULT 0,
  managed     INTEGER NOT NULL DEFAULT 0,
  missing     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE review_comments (
  id              TEXT PRIMARY KEY,
  worktree_id     TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  file            TEXT NOT NULL,
  line            INTEGER NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('old', 'new')),
  code            TEXT,
  commit_sha      TEXT,
  text            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  sent_provider   TEXT,
  sent_session_id TEXT
);
CREATE INDEX review_comments_wt ON review_comments (worktree_id, created_at);

CREATE TABLE agent_session_pins (
  worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
