# alfred-pr235-misses (alfred PR#235, "presentation-layer attention demotion", ADR-0064, commit a99d732f)

Dogfood head-to-head (2026-06-21). On this PR warden's `review` surfaced 2
findings — one a false positive (`gather.ts:418` activityCount saturation,
harmless because the cap of 25 sits above the busy threshold of 8) and one
shallow real one (`email-triage.ts:337` sequential `getSenderSignificance`
await). An OpenAI-harness review driven by a staff-engineer system prompt
(investigation protocol + domain checklists + access to the PR description /
ADR / journals — see gist yashgkr/98659ca0dbbfbb84c5ddf3cdfa8db6d4) found the
5 substantive issues labeled below.

Budget was ruled out: the warden run had worker-budget headroom, all target
files were in the diff, and the bugs were verified present in the committed
code. Root cause is recall/depth, not cost — see memories
`project_warden_pr235_openai_headhead` and `project_warden_recall_is_agency_gap`.

Each label is tagged with the lever expected to close it:

- **[prompt]** — closeable by a diligent worker-prompt variant (investigation
  protocol + N+1 / data-dependency checklist). Workers already have
  readFile/grepRepo/lookupTypeDef + multi-step; the prompt under-drives them.
- **[intent]** — needs the PR description / ADR fed as adjudication context so
  the worker can check code against the stated invariant (needs code + ADR).
- **[lane]** — evidence spans an unchanged out-of-diff consumer; current lane
  discipline drops such findings (needs code + ADR).

NOTE: `diff.patch` is the full committed diff and includes the 6,618-line
generated `0044_snapshot.json`. Until the prune profile drops
`migrations/meta/`, this fixture is expensive to run (the snapshot is fed to
the boss every round). Run it only after the prune fix, or with the snapshot
stripped.

```yaml
id: pinned-demanding-never-wired
path: packages/contracts/src/attention.ts
category: correctness
description: scoreAttentionForItems accepts pinnedDemanding (attention.ts:125) but neither live consumer passes it — briefing/read.ts:167 and chat-shell.tsx:1549 send only category/significance/recurrence. A weak or repeated bulk urgent exposed-secret item can be demoted to normal/muted, contradicting the "security pins stay" invariant. Levers: [prompt] (grep callers to see the param is never supplied) + [intent] (the security-pin invariant lives in ADR-0064 / PR desc, not the code).
```

```yaml
id: recurrence-reversed-for-newest-first
path: packages/contracts/src/attention.ts
category: correctness
description: scoreAttentionForItems assigns recurrence by input order (attention.ts:257) but briefing and inbox feed it newest-first rows (read.ts:142, me/routes.ts:493). The latest (e.g. tenth) alarm is treated as the first occurrence and stays demanding; older copies get muted. Fix = score in chronological order then map back. Levers: [lane] (the consumer proving the order, me/routes.ts, is unchanged and out-of-diff) + [intent] (recurrence-decay contract is stated, not in-code).
```

```yaml
id: day-shape-shipped-ignores-window
path: packages/api/src/modules/briefing/gather.ts
category: correctness
description: gatherDayShape accepts windowStart/windowEnd but the resolved-objects query is fetched with no time filter (gather.ts:473 — committed code has no deliveredWithin). An evening briefing recap can show stale or future-resolved PRs as "what shipped today," especially on retries. Lever: [prompt] — within a file warden already reviewed; a worker that traced the windowStart/windowEnd params to their (missing) use would catch it. (Fix now present in working tree.)
```

```yaml
id: sender-significance-n-plus-1
path: packages/api/src/modules/briefing/read.ts
category: scalability
description: Briefing does one alias JSONB scan per distinct sender (read.ts:209 via significance.ts:251); the triage workflow also calls resolveSenderRelationship then getSenderSignificance separately for the same address (email-triage.ts:648). Batch the briefing lookup; share metadata in classify. Lever: [prompt] — textbook "loop contains a query → N+1" checklist item. Warden found the adjacent sequential-await (email-triage.ts:337) but not this.
```

```yaml
id: literal-nul-byte-in-source
path: packages/contracts/src/attention.ts
category: committability
description: attention.ts:265 contains an actual NUL separator in a template literal. Passes TS but is hostile to search/editor tooling. Use "\0" or a printable delimiter constant. Lever: [prompt] — but tier-3/committability is verbose-gated in warden's default output, so it may be found-then-suppressed rather than missed.
```
