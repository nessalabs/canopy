# Independent Canopy reader and model review

Scope: 17-page draft at source b8d983c7b7b0221adb6d702207773f3a6c1752bd, reviewed from Markdown. Browser checked separately by author/parent harness. This is an agent reader exercise, not human usability research.

## Docs-only answers recorded before implementation reads

- Root → Provision: returned checkout means queued acceptance. Failed setup keeps earlier effects; inspect step/log before retry. Exact support: “it does not roll back earlier steps.” Default restart point and no-config outcome explained.
- Root → Agents → Permissions: tab closure disconnects follower, not turn. A matching still-pending permission may be answered; a stale/foreign answer is refused and grants no future request. Explicit interrupt is separate and not rollback.
- Root → Removal: force is needed for dirty secondary checkout, but salvage failure does not stop destruction. Commit/save independently before force; trash only helps if a saved entry exists. The diagram labels salvage as an attempt.
- Root → Changes: changed patch hash refuses hunk rewrite. Staged text no longer represented by working-tree hunks also refuses; deliberately stage/unstage whole file, inspect refreshed index. Queue scope excludes external git.
- Root → GitHub: PR failure may follow successful push or creation. Refresh remote and branch before retry, rather than assuming nothing happened.
- Root → Services: desired running differs from health; stopped projection after a logged stop error is not external cleanup proof. Inspect actual runner/owner and logs.

No material answer required guessing in these six sampled tasks. Terms worktree, desired state and generation are explained locally. The source and model pass below checks whether those answers are justified.

## Source and adversarial model review

Inspected pipeline newRun/runPipeline/resumePoint; PermissionDesk key/ask/answer/allowPending; supervisor stopOne/onExit/beginHealth; CommitService stageHunks/commit; WorktreesService destroy/salvage; GitHubService push/createPr; TurnHub start/drain/follow. These support the six recorded answers. Important distinctions remain visible: teardown precedes removal; salvage errors are caught; stop errors still publish stopped; push precedes PR creation/readback; follower cancellation does not abort the source iterator.

All four models and eight guard-removal controls reviewed against those owners:

- ProvisionOrder independently explores first-stage failure and abort timing. Controls remove one continuation guard; stored prior-failure/abort facts detect second-stage entry. It does not model undo, retry idempotency or full cancellation propagation.
- PermissionDecision independently varies supplied/current composite identity and forced-ask status. Reply and automatic acceptance mutants break the intended rules. Concurrent reused map keys and provider policy remain explicitly outside the model.
- HunkSelection independently varies offered/current patch identity and representability. Acceptance snapshots avoid treating a later edit as an earlier violation. The real check/write interval is asynchronous; the page explicitly excludes external mutation atomicity.
- ServiceCallback accepts an issued generation only while current and undisposed. Snapshots check acceptance-time facts, and the two controls remove only the respective source guards. Only the asynchronous health-probe branch is modeled; no-cleanup/leak claims are made.

No material finding in the reviewed scope. I did not rerun implementation tests or TLC: those executions and final result qualification belong to the author's linked receipts. Source reads and model/control inspection are distinct evidence. Browser appearance, every route, native/external processes and actual provider operations are excluded from this review. Before publication the pending verification paragraph must be replaced with actual final evidence or explicit remaining gaps.


## Visual follow-up

Parent screenshot review found the services chart omitted stop/exit from Unhealthy and explicit restart from Failed. The author added those source-supported edges (WorktreeSupervisor startOne/stopOne/onExit). Model meaning unchanged; affected chart rerendered as part of final browser recheck. Parent inspected the refreshed services screenshot and closed the finding; no unresolved material visual issue in that sample.
