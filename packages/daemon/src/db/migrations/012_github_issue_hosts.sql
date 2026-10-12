-- The copy is keyed by host as well as `owner/name`, so an Enterprise repository and a
-- github.com one of the same name stay apart. Everything kept so far came from github.com.
UPDATE github_issues SET repo = 'github.com/' || repo;
UPDATE github_issue_syncs SET repo = 'github.com/' || repo;
UPDATE github_issue_threads SET repo = 'github.com/' || repo;
