# alfred-pr131-falsepos (alfred PR#131, `codex/fix-code`, head `9349d565`)

This fixture captures the eight Warden findings the user refuted during the
2026-06-17 dogfood review. They are precision traps, not recall labels: each
`expect: absent` block marks a comment shape that must not reappear.

The shared symptom is that the flagged line exists, but the review should not
ship that comment. In four cases the line is outside the patch's added hunks. In
the other four, a second piece of code refutes the claim: a caller-normalized
input, callee guard, or boolean/control-flow invariant. `diff.patch` is the full
PR diff (`origin/main...9349d565`) so the boss sees the same broad PR context
that produced the original false positives; `meta.json` checks out the full PR
head worktree so worker tools can read surrounding files.

Diff anchoring is intentionally mixed because the original dogfood produced two
precision failures. Four traps are on changed hunks (`reasoning-section`,
`sender-context`, `dry-run`, `sender-relationship`) and exercise reasoned-claim
soundness. Four traps are outside added hunks (`classify` x2, `approval-card`,
`user-authored-brief`) and exercise the deterministic rule that review comments
must be anchored to added diff lines. A keyed baseline run should record which
traps reproduce before this fixture is treated as load-bearing calibration data.

```yaml
id: classify-second-pass-failure-keeps-first-pass
expect: absent
path: packages/api/src/modules/triage/classify.ts
line: 770
claim_includes: second
description: Warden claimed the second-pass failure path mutates the wrong classification. Refutation: `working = secondPass` runs only after `runPass` succeeds; when `runPass` throws, the catch still sees `working` as `firstPass` and patches firstPass intentionally.
```

```yaml
id: reasoning-section-below-both-thresholds-boolean
expect: absent
path: apps/web/src/routes/-chat/reasoning-section.tsx
line: 61
claim_includes: threshold
description: Warden claimed the `||` should be `&&`. Refutation: the code drops only when the block is below both thresholds; `!(len || dur)` is exactly that condition, while `&&` would keep only blocks above both thresholds.
```

```yaml
id: sender-context-noreply-case-bypass
expect: absent
path: packages/api/src/modules/triage/sender-context.ts
line: 255
claim_includes: noreply
description: Warden claimed `NoReply@` bypasses `STRONG_SERVICE_LOCAL`. Refutation: the only caller derives `localPart` from `parseFromHeader`, which lowercases `addressRaw.slice(0, at)` before `isHumanLikeSender` receives it.
```

```yaml
id: approval-card-success-busy-state
expect: absent
path: apps/web/src/components/approvals/approval-card.tsx
line: 57
claim_includes: busy
description: Warden claimed successful approval leaves the buttons busy. Refutation: successful `onDecide` removes the row from the Replicache pending queue and unmounts the card; the code comment states no local cleanup is needed.
```

```yaml
id: sanitize-assist-length-after-relative-resolution
expect: absent
path: packages/api/src/modules/triage/classify.ts
line: 608
claim_includes: length
description: Warden claimed the max-length check should happen before relative-date resolution. Refutation: the resolved text is what renders in the UI, so bounding the post-resolution string is intentional.
```

```yaml
id: dry-run-null-sender-relationship-safe
expect: absent
path: apps/server/src/scripts/dry-run-triage-backfill.ts
line: 125
claim_includes: senderAddress
description: Warden claimed passing a nullable senderAddress to `resolveSenderRelationship` is unsafe. Refutation: the callee returns null when `!args.isHumanSender || !args.senderAddress`; only `isKnownContact` lacks that guard and needs the external check.
```

```yaml
id: sender-relationship-null-metadata-safe
expect: absent
path: packages/api/src/modules/triage/sender-relationship.ts
line: 114
claim_includes: metadata
description: Warden claimed `parsePersonEntityMetadata(metadataRaw)` throws on null metadata. Refutation: the callee does `safeParse(raw ?? {})`, so null becomes an empty metadata object.
```

```yaml
id: user-authored-brief-transcript-preserved
expect: absent
path: packages/api/src/modules/agent/workflows/user-authored-brief.ts
line: 203
claim_includes: transcript
description: Warden claimed a step returning without `transcript` loses the stored transcript. Refutation: the executor only writes transcript when `result.transcript !== undefined`, so omitting the field preserves the existing transcript by design.
```
