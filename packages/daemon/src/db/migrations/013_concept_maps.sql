-- Concept maps of a worktree's pull request: the hierarchy of meaning the Concept Graph pane
-- draws. Each is pinned to the two commits it was cut from — for a pull request, the pair GitHub
-- itself diffs — so its hunks still read after a commit, a push or a rebase. `result_json` is the
-- newest answer, kept so the map outlives the session's transcript.
CREATE TABLE IF NOT EXISTS concept_maps (
  id           TEXT PRIMARY KEY,
  worktree_id  TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  -- 'pull-request' or 'branch' (the fallback when the branch has no PR open).
  subject      TEXT NOT NULL,
  -- The PR this describes, and its head at the time, so a later push can be noticed. Null for a
  -- map cut from the branch instead.
  pr_number    INTEGER,
  head_sha     TEXT,
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
CREATE INDEX IF NOT EXISTS concept_maps_wt ON concept_maps (worktree_id, created_at);
