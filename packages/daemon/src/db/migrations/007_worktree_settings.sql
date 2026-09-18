-- Worktrunk is gone; `canopyd` creates worktrees now, and the settings key moved with it.
--
-- The old `$.worktrunk` object held `enabled`, `worktreePath`, `hooks`, `syncProjectConfig`
-- and `listUrl`. Only the first two survive: hooks and the `[list] url` existed to drive a
-- second config file (`.config/wt.toml`) that Canopy never owned, and that file is no longer
-- written or read.
--
-- Settings are stored as one blob, so this rewrites the object in place. A project whose
-- settings were never saved has no blob and picks up the new defaults on its own.
UPDATE projects
SET settings_json = json_remove(
      json_set(
        settings_json,
        '$.worktree',
        json_object(
          -- `enabled` meant "use the tool rather than plain git"; the tool changed, the
          -- preference did not.
          'tool', json_extract(settings_json, '$.worktrunk.enabled') = 1,
          -- A path template the user chose is theirs; carry it across unchanged.
          'worktreePath', coalesce(json_extract(settings_json, '$.worktrunk.worktreePath'), '{{ repo }}/worktrees/{{ name }}')
        )
      ),
      '$.worktrunk'
    )
WHERE settings_json IS NOT NULL
  AND json_valid(settings_json)
  AND json_type(settings_json, '$.worktrunk') = 'object';
