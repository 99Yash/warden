# m14-closeout (commits d1f7fae...89bf988)

The M14 close-out delta as shipped, pre-labeled by
`project_warden_m14_boss_laziness.md`. Three issues the M14 boss-loop
**missed** during dogfood (it returned 0 comments at $0.10–$0.17 / 15.3–
56.5s across two runs). These labels make the missed-issues catchable for
candidate configs and let us see whether M15's calibration recovers them.

Note: the price-table duplication landed in `cli/src/format.ts` mid-delta
and was later collapsed by commit `0f0191b` (also in this diff range). The
LABEL points at the duplication site — if a config catches the issue
before the cleanup commit it counts. The diff range here includes both
states; the boss reasoning over the full diff should still spot it.

```yaml
id: cached-input-token-multiplier-uncited
path: packages/core/src/review-harness/harness.ts
line: 210
category: consistency
description: CACHE_HIT_PRICE_MULTIPLIER = 0.1 is stated as Anthropic's 10% cache-hit price but is not cited to Anthropic's pricing docs; doc-vs-code drift if Anthropic's actual cache-hit rate is 10x cheaper (not 10% of input). Comment at line 199 says "10%" but the rate is a 10x discount (which IS 10% of full price).
```

```yaml
id: optional-spread-pattern-in-runReview
path: packages/core/src/index.ts
line: 207
category: clarity
description: runReview() builds the harness input with optional-spread (`...(input.config.verbose !== undefined ? { verbose: input.config.verbose } : {})`) — repeats the same pattern for 3 fields. Pattern is correct (avoids passing `undefined` fields under exactOptionalPropertyTypes) but heavily repeated; could extract a helper or restructure once `bossLoop` is also optional. Soft clarity finding.
```

```yaml
id: price-table-duplication
path: packages/core/src/review-harness/harness.ts
line: 202
category: dedup
description: Pricing table (PRICE_PER_M_TOKENS) lives in harness.ts. Pre-collapse it was also mirrored in packages/cli/src/format.ts (see commit 0f0191b which collapsed it). Boss should have caught the duplication during the close-out review pass that landed BOTH files in the same diff range.
```
