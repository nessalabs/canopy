-- Graphs of a worktree's change, each pinned to the two trees it was cut from, so it still reads
-- once the change is committed or rebased. `scope_json` says which change (uncommitted, branch,
-- a run of commits, the pull request); `result_json` is the newest answer, kept so the graph
-- outlives the session's transcript. Replaces change_groupings, whose rows the store converts.
CREATE TABLE IF NOT EXISTS review_graphs (
  id           TEXT PRIMARY KEY,
  worktree_id  TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  scope_json   TEXT NOT NULL,
  preset       TEXT NOT NULL,
  instructions TEXT NOT NULL,
  before_tree  TEXT NOT NULL,
  after_tree   TEXT NOT NULL,
  ids_json     TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  pr_number    INTEGER,
  head_sha     TEXT,
  provider     TEXT,
  session_id   TEXT,
  result_json  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_graphs_wt ON review_graphs (worktree_id, created_at);
