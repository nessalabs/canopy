-- Who each issue or PR is assigned to, as ` login login ` so one login matches with LIKE.
ALTER TABLE github_issues ADD COLUMN assignees TEXT NOT NULL DEFAULT '';

-- Rows synced before assignees were kept have none; the next search rebuilds the copy.
DELETE FROM github_issue_syncs;
