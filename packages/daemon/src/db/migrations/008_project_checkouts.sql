-- Every checkout a project has had, kept after the worktree is gone. Agent sessions are filed by
-- the directory they ran in (`~/.claude/projects/<munged cwd>`, Codex's rollouts by cwd), and a
-- destroyed worktree takes its row in `worktrees` with it — so without this, the conversations
-- that built a branch would drop out of Canopy the moment the branch's worktree is cleaned up.
-- The main checkout's Agent tab lists sessions from every path here.
--
-- Filled by triggers rather than by the service, so every way a row arrives (a sync, a create,
-- an adopt) and leaves (a destroy, a reap) is covered without each path having to remember.
CREATE TABLE IF NOT EXISTS project_checkouts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL,
  branch     TEXT,
  first_seen INTEGER NOT NULL,
  -- Null while a worktree row for the path exists.
  removed_at INTEGER,
  PRIMARY KEY (project_id, path)
);

INSERT OR IGNORE INTO project_checkouts (project_id, path, name, branch, first_seen, removed_at)
SELECT project_id, path, name, branch, created_at, NULL FROM worktrees;

CREATE TRIGGER IF NOT EXISTS project_checkouts_insert AFTER INSERT ON worktrees
BEGIN
  INSERT INTO project_checkouts (project_id, path, name, branch, first_seen, removed_at)
  VALUES (NEW.project_id, NEW.path, NEW.name, NEW.branch, NEW.created_at, NULL)
  ON CONFLICT (project_id, path) DO UPDATE SET name = excluded.name, branch = excluded.branch, removed_at = NULL;
END;

-- A create renames the row after git lists it, and a branch can be switched in place.
CREATE TRIGGER IF NOT EXISTS project_checkouts_update AFTER UPDATE OF name, branch ON worktrees
BEGIN
  UPDATE project_checkouts SET name = NEW.name, branch = coalesce(NEW.branch, branch)
  WHERE project_id = NEW.project_id AND path = NEW.path;
END;

CREATE TRIGGER IF NOT EXISTS project_checkouts_delete AFTER DELETE ON worktrees
BEGIN
  UPDATE project_checkouts SET removed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE project_id = OLD.project_id AND path = OLD.path;
END;
