-- Conversations the Git Agent had about a worktree, so its history can open one again after
-- its tab is closed. The transcript stays with the provider; this only remembers which ones.
CREATE TABLE IF NOT EXISTS git_agent_sessions (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, provider, session_id)
);

-- Groupings of a worktree's change, each pinned to the two snapshot trees it was made from, so
-- it still reads once the change is committed. `result_json` is the newest answer, kept so the
-- groups outlive the session's transcript.
CREATE TABLE IF NOT EXISTS change_groupings (
  id           TEXT PRIMARY KEY,
  worktree_id  TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  against      TEXT NOT NULL,
  instructions TEXT NOT NULL,
  before_tree  TEXT NOT NULL,
  after_tree   TEXT NOT NULL,
  ids_json     TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  provider     TEXT,
  session_id   TEXT,
  result_json  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS change_groupings_wt ON change_groupings (worktree_id, created_at);
