-- Which worktrees a session has worked in, whatever its own cwd. A session started in the main
-- checkout that edits a worktree's files is a session of that worktree too, and the worktree's
-- Agent tab should say so. Rows come from the hooks, one per (session, worktree), and keep the
-- first and latest moment the session touched that checkout.
CREATE TABLE agent_session_worktrees (
  provider    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  -- The session's own working directory, so a listing can tell "from here" from "from elsewhere".
  cwd         TEXT NOT NULL,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (provider, session_id, worktree_id)
);
CREATE INDEX agent_session_worktrees_worktree ON agent_session_worktrees (worktree_id, last_at);
