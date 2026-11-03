---
id: "github"
title: "Land a branch or send it to GitHub"
kind: "flow"
status: "implemented"
summary: "Local merge, push and GitHub mutation have separate acceptance and failure boundaries."
parent: "canopy"
sources:
  [
    "packages/daemon/src/worktrees/merge.ts",
    "packages/daemon/src/github/service.ts",
    "packages/daemon/src/github/issues.ts",
    "packages/daemon/src/github/issue-cache.ts",
    "packages/daemon/src/routes/github.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Choose local landing or a pull request

A local merge lands the worktree branch on its configured base. Merge and squash need the base checked out somewhere and refuse a dirty/busy base. Fast-forward can update an unchecked-out base ref with git fetch from the local repository. Detached worktrees, the primary checkout, missing bases and branches with nothing to contribute are refused.

On merge failure Canopy tries merge --abort, or reset --merge for squash, and reports conflict paths when available. Cleanup errors are caught. Inspect the base checkout after a failure rather than assuming an infallible rollback. The merge queue serializes this daemon's operations per base checkout, not arbitrary external git commands.

## Push and create a PR

Push targets the chosen remote explicitly and sets upstream on first push. PR creation requires gh readiness, a branch distinct from base, and pushes missing/ahead commits before invoking gh pr create. If creating or reading back the PR fails, a push or even PR creation may already have succeeded. Refresh GitHub and the branch before repeating the request.

The GitHub owner also reads PR choices, reviews/threads, options, repository issues and timelines, and performs the requested PR actions through gh. Cached lists are observations; refreshing remote data can fail independently of local git status. Posting a review marks selected local comments sent after the GitHub operation's path. A local comment is not automatically public until a send/action occurs.

Issue lists, assignees, attachments and # references support the composer and command center. They depend on the configured GitHub host, credentials and network. Source and fake-gh tests establish request construction and local state transitions, not successful live posting to GitHub. This documentation task did not perform those product actions.
