# Make large generated-file prune drops loud (transparency)

**Severity:** low. Follow-up to the prune fix shipped this session.

## Context

Generated Drizzle artifacts (`_snapshot.json`, `_journal.json`) are now pruned
via the JS profile `extensions` list. Extension-based pruning is **silent**
(step 3 in `pruneDiff` emits no degraded entry, by m9-plan §4 design: "loud
about subtrees, quiet about individual files").

That design choice is what hid the original cost problem: the 6,618-line
`0044_snapshot.json` was fed to the boss every round, driving a review to $11,
with nothing in the output explaining why. Now it's pruned — but still
silently. A future large generated file dropped this way would again be
invisible.

## Proposal

Emit one `info`/`actionable` degraded entry when a _single_ pruned file exceeds
a line/byte threshold (e.g. >500 changed lines), even on the silent extension
path — so the review log says "skipped 6,618-line generated
`migrations/meta/0044_snapshot.json`". Keep small drops silent.

## Secondary

`_snapshot.json` / `_journal.json` are Drizzle-specific suffixes living in the
generic `javascript.json` profile. Acceptable for now (Drizzle is ubiquitous in
this stack), but consider a dedicated ORM/db-tooling profile if the JS profile
accumulates more framework-specific entries.

## Refs

- `packages/core/src/diff/prune.ts` (`pruneExtensions` is silent)
- `packages/core/src/ecosystem/profiles/javascript.json`
