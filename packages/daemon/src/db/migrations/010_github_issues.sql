-- A repository's issues and PRs as GitHub last described them, so the `#` menu and the Issues
-- view search them here and only ask GitHub for what changed since `synced_at`.
CREATE TABLE IF NOT EXISTS github_issues (
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL,
  url        TEXT NOT NULL,
  author     TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS github_issues_list ON github_issues (repo, kind, state, updated_at);

CREATE TABLE IF NOT EXISTS github_issue_syncs (
  repo      TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL
);

-- One issue's thread, kept for as long as the issue's `updated_at` says nothing has changed.
CREATE TABLE IF NOT EXISTS github_issue_threads (
  repo        TEXT NOT NULL,
  number      INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  thread_json TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
