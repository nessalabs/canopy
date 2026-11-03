---
id: "verification"
title: "Read evidence and reproduce checks"
kind: "guide"
status: "implemented"
summary: "Executed local checks and bounded models are distinct from platform and cloud qualification."
parent: "canopy"
sources:
  [
    "package.json",
    "packages/daemon/tests/migrate.test.ts",
    "packages/daemon/src/db/migrate.ts",
    "packages/daemon/src/db/migrations/014_review_graph_lines.sql",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Check the evidence before relying on a claim

The atlas checkpoint is the inspected source revision. It covers implemented owner families, with selected finite models for permission matching, service health generations, hunk admission and pipeline stage ordering. These abstractions are not execution of TypeScript or proof of every app feature.

## Actual local checks

`npm ci` completed and `npm run typecheck` passed across workspaces on arm64 macOS. `npm test` exited nonzero: daemon 498 passed, 24 skipped, 1 failed; shared 93 passed; UI 359 passed. The failure is the existing migrate test “applies a migration added below the version already reached.” It first migrates to latest, removes the ledger and sets version 4, but leaves review_graphs.lines_json from 014. Reapplying 014 then raises duplicate column. Fresh-database and repeated-current migration tests pass. This fixture result is neither a green suite nor evidence that a genuine version 4 database already contains that column.

Live Docker/database tests remain skipped where gated. UI tests and type checks do not qualify an installed Electron app, authenticated providers or remote GitHub mutations. No real product data or user configuration was used for test setup.

## Reproduce

Run `npm ci`, `npm test`, `npm run typecheck` and `npm run build:web` from the repository root with its supported Node version. Keep the failing migration result visible until its fixture or implementation is independently corrected. This documentation change does not alter the baseline tests to hide a failure.

For docs/models, set NESSA_DOCS_ROOT to a built canonical nessa-docs checkout, then run `node scripts/state-docs/check.mjs --models --write` and `node scripts/state-docs/probe-models.mjs`. Catalog validation without --models does not run TLC. Negative controls deliberately weaken guards in memory and retain the original invariants; they never replace the authored baseline.

## Final documentation evidence

All four bounded models passed eight invariants across 57 aggregate states; eight negative controls each broke the expected semantic rule with none unchecked. [Baselines](../../verification/state-models/baselines.json) and [controls with counterexamples](../../verification/state-models/negative-controls.json) preserve source, dates, checker and model digests. Models deliberately disable terminal deadlock checking and make no liveness claim.

[Independent review](../../verification/state-models/independent-review.md) followed six docs-only reader paths before checking source and all four models/eight controls, with no unresolved material finding. [Browser verification](../../verification/state-models/browser.json) opened all 17 pages and 6 diagrams in headless Chrome with no page/diagram errors. This is documentation rendering evidence, not interaction testing of the Canopy product.

`npm run build:web` passed, with the bundler's large-chunk warning. Retained [test output](../../verification/state-models/tests.txt), [typecheck output](../../verification/state-models/typecheck.txt) and [web build output](../../verification/state-models/build-web.txt) show the actual commands' results, including the migration-fixture failure above. Documentation checks passing does not turn that executable-suite failure green.
