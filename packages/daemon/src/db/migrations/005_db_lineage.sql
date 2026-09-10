-- Records what a fork was really copied from, so the UI can distinguish "forked from
-- wt_..._develop" from "asked for a fork, got an empty database".
--
-- A rebuild rather than two ALTER TABLE ADD COLUMNs: this shipped briefly as a second `004_`
-- file, so a database may already carry the columns (applied) or not (skipped past by the old
-- version-number runner) with no way to tell in SQL. Recreating the 003 table with the two
-- columns added lands the same schema either way; the lineage of any fork that did record it
-- is dropped, and is written again the next time that fork is re-seeded.
CREATE TABLE db_instances_new (
  worktree_id          TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  adapter              TEXT NOT NULL,
  status               TEXT NOT NULL,
  url                  TEXT,
  forked_from          TEXT NOT NULL,
  forked_from_database TEXT,
  forked_from_branch   TEXT,
  detail_json          TEXT NOT NULL DEFAULT '{}',
  size_mb              REAL,
  seeded_at            INTEGER,
  error                TEXT,
  PRIMARY KEY (worktree_id, name)
);

INSERT INTO db_instances_new (worktree_id, name, adapter, status, url, forked_from, detail_json, size_mb, seeded_at, error)
SELECT worktree_id, name, adapter, status, url, forked_from, detail_json, size_mb, seeded_at, error FROM db_instances;

DROP TABLE db_instances;
ALTER TABLE db_instances_new RENAME TO db_instances;
