-- One row per file a tool call changed, with the worktree trees before and after the call.
CREATE TABLE agent_edits (
  provider    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  before_tree TEXT NOT NULL,
  after_tree  TEXT NOT NULL,
  attributed  INTEGER NOT NULL DEFAULT 1,
  at          INTEGER NOT NULL,
  PRIMARY KEY (provider, session_id, tool_use_id, path)
);
CREATE INDEX agent_edits_session ON agent_edits (provider, session_id, at);
