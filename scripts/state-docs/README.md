# State documentation verification

Run from the repository root with Node 24 and `NESSA_DOCS_ROOT` pointing to a built nessalabs/nessa-docs checkout. The renderer owns YAML validation, pinned TLC/Java cache, execution bounds and result serialization. These wrappers only compose its interfaces.

- `node scripts/state-docs/check.mjs`: validate the catalog.
- `node scripts/state-docs/check.mjs --models`: check the linked models without edits.
- Add `--write` to save canonical unmodified results, or `--install` to explicitly install the pinned checker cache.
- `node scripts/state-docs/probe-models.mjs`: rerun all baselines and the controls in `probes.mjs`, printing one JSON receipt to stdout and progress to stderr. No automatic download or authored model mutation occurs.

Exit zero means complete pass; nonzero means failure or incomplete/unavailable verification. Negative-control failure means an expected design rule detected an intentionally introduced fault. It is not a production failure. Control receipts retain exact model digests and semantic counterexamples. See `docs/state/verification.md` for source and evidence limits.
