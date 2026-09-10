-- Worktrees moved into the project's Canopy home: `~/.canopy/<project>/worktrees/<name>`,
-- alongside the canopy.yaml a repo may keep there instead of in the checkout.
--
-- Settings are stored as a whole blob, so every project whose settings were ever saved
-- carries a copy of the previous default path template. Rewrite only that exact value: a
-- template the user actually chose is theirs, and worktrees already on disk keep the
-- absolute path they were created with either way.
UPDATE projects
SET settings_json = json_set(settings_json, '$.worktrunk.worktreePath', '{{ repo }}/worktrees/{{ name }}')
WHERE settings_json IS NOT NULL
  AND json_valid(settings_json)
  AND json_extract(settings_json, '$.worktrunk.worktreePath') = '{{ repo }}/{{ name }}';
