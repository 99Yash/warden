# 01 — Round 0: bounded surface sweep (docs-only diff)

**PR:** #50 · branch `feat/mcp-server-skeleton` · diff `1a4ab32c...HEAD`
**Scope:** 6 files, +181/−5, docs-only (no runtime code)
**Reference:** `../alfred/docs/reference/code-style.md` — surface sweep, rule-guided

---

## 0. Adaptation note — which code-style rules apply to a docs diff

This diff contains **zero TypeScript**. I am stating the N/A rules explicitly rather than
silently skipping them, per the brief.

| code-style.md rule | Applies? | Why |
| --- | --- | --- |
| §1 derive-don't-hand-roll (`$inferSelect`, `z.infer`, `Pick<>`/`Omit<>`) | **N/A (types)** | No TS. The *analogue* is §1's stated principle — "a local shape that mirrors a source of truth and silently drifts from it" — restated as prose. That analogue **does** apply and is covered in §B below. |
| §2 no `any` / no `Record<string, any>` | **N/A** | No TS. |
| §2 guards over casts | **N/A** | No TS. |
| §2 exhaustive switch / `const _exhaustive: never` | **N/A** | No TS. |
| §2 minimize `!`, `process.env` banned, `exactOptionalPropertyTypes` | **N/A** | No TS. |
| §2 **constants/config ownership by narrowest stable owner** | **APPLIES (doc analogue)** | A canonical description must have exactly one owning doc. Covered in §C. |
| §3 backend (N+1, transactions, timeouts, idempotency, logging, webhook HMAC, migrations) | **N/A** | No runtime code. |
| §4 frontend (effects, SSR, a11y, keys) | **N/A** | No frontend. |
| §5 **tests assert behaviour, not spelling** | **APPLIES (claims only)** | The diff *makes* test claims in prose (ADR-0053 "Eval gate", ADR-0030 amendment "what the smoke suite must now assert"). Those claims are checkable without running anything. Covered in §E. |
| Hit-list #1–#11 | **APPLIES selectively** | Enumerated in §F. |
| *(added for docs)* cross-reference resolution | **APPLIES** | Covered in §D. |
| *(added for docs)* markdown table integrity | **APPLIES** | Covered in §E. |

---

## A. must-fix

### A1. `decisions.md:61` — the ADR-0053 snapshot row is **committed mid-truncation**, with a tool artifact baked in

This is the highest-severity finding in the diff and it is mechanical.

`decisions.md` has a wide 3-column status-snapshot table (rows 19–62). Every existing row has
exactly **3** pipe characters (leading + 2 delimiters + trailing). The new ADR-0053 row at
line 61 has **2**:

```
$ python3 -c "print(open('decisions.md').read().split(chr(10))[60].count('|'))"
2
```

The row's closing `|` is gone, and the row terminates in a **literal truncation string that was
pasted out of a tool's stdout** rather than being written:

```
… No code at commit time; PRD #38, slices #39–#48, gate #49.
                      ... (line truncated to 2000 chars)
```

Confirmed by reading the file directly (not the diff, which truncates on display):

```
$ grep -rln 'line truncated to' . --exclude-dir=node_modules --exclude-dir=.git
./decisions.md
```

Two distinct defects:

1. **Corrupted table row.** 2 columns in a 3-column table. GitHub renders it with a missing
   cell, so the row silently loses the trailing `| Note` column delimiter. This is exactly the
   "unescaped/malformed pipe corrupts a table row" case the brief calls must-fix.
2. **Committed tool output artifact.** `... (line truncated to 2000 chars)` is now repo content.
   It is the only occurrence of that string anywhere in the tree, which confirms it arrived with
   this commit and not by pre-existing convention. It reads as a corruption marker to anyone
   scanning `decisions.md`.

**Fix:** restore the closing `|`, delete the artifact string, and re-pad the leading cell to the
table's column width. Do it by editing the file, not by re-running whatever command produced it —
the 2 000-char tool limit is what caused this, so the row should be assembled to fit or split
deliberately.

Note this row is also the widest in the table (2 435 chars vs 2 046 for the next widest). It is a
single-sentence restatement of all eleven of ADR-0053's decision points — see C1 for why that
shape is itself a problem.

---

### A2. `docs/milestones.md:22` — broken relative link `../blob/main/decisions.md`

```markdown
- [ ] **OpenCode MCP pivot …** (direction locked by [ADR-0053](../blob/main/decisions.md), …)
```

`milestones.md` lives in `docs/`, so `../blob/main/decisions.md` resolves to
`<repo-root>/blob/main/decisions.md` — **which does not exist**. Verified:

```
$ [ -e blob/main/decisions.md ] ; echo $?
1
```

`../blob/main/…` is a GitHub *web-URL* fragment (`github.com/99Yash/warden/blob/main/…`), not a
repo-relative path. It was pasted into a relative-link slot. In rendered markdown this is a dead
link on the **first, boldest, most-read row of the pivot** — the row the diff itself instructs the
reader to read before M18/M19.

**Fix:** `[ADR-0053](../decisions.md)`.

**Same line, second defect:** `slices \`to-issues/opencode-mcp-{00..10}\`` is presented as a path
but is (a) repo-root-relative while rendered from `docs/`, so it needs `../to-issues/…`; and (b)
brace-expansion shorthand that no reader or link-checker resolves. Spell out
`../to-issues/opencode-mcp-00-adr-sweep.md` … `-10-ci-runner.md`, or point at
`to-issues/README.md`, which already carries the authoritative ordered table with per-slice links.

---

### A3. `decisions.md` ADR-0053 §Locus — `to-issues/opencode-mcp-{01..10}` omits the slice this very PR adds

```markdown
**Locus.** … Slice order and the parity gate: `to-issues/opencode-mcp-{01..10}` + issues #39–#48;
**#45** (index export/import) is independent and unblocked.
```

Two problems in one clause:

- **Stale by construction.** This diff *adds* `to-issues/opencode-mcp-00-adr-sweep.md`, yet the new
  ADR's locus enumerates `{01..10}`. The slice list and the ADR that defines the pivot disagree
  inside the same commit.
- **Brace shorthand is not a path.** `{01..10}` is a shell glob idiom; in a Markdown doc it is
  decoration. It cannot be `stat`'d, link-checked, or navigated. §D of the brief asks explicitly
  — the answer is no, it should be spelled out, or replaced with a link to `to-issues/README.md`,
  which already is the single ordered slice table.

ADR-0053's own **Status** paragraph gets this right ("sliced into #39–#48, with the ADR sweep filed
as #49"), so the ADR contradicts itself between §Locus and §Status.

---

## B. follow-up

### B1. The pivot's canonical description now lives in seven places with no stated owner

code-style §2's "constants and configuration ownership — put the constant at the narrowest stable
owner" translates directly: *put the decision at the narrowest owning doc*. The pivot is now
described, in full, in:

1. `decisions.md:61` — snapshot-table row (~2.4 kB restatement of all 11 decision points)
2. `decisions.md` — ADR-0053 §Context/§Decision §1–§11/§Locus/§Eval gate/§Why/§Ripple
3. `CONTEXT.md:259-271` — five new §6 entries (`engine boundary`, `motion`, `lane`, `post-pass`,
   `tool envelope`, `state authority`)
4. `docs/milestones.md:22` — ~1.6 kB restatement including the full 10-step slice order
5. `to-issues/README.md:38-57` — prose paragraph + 11-row slice table
6. `to-issues/opencode-mcp-00-adr-sweep.md` — "What to build" restates ADR-0053's decision list
   near-verbatim
7. `docs/prd-opencode-mcp.md:145-212` + `docs/opencode-mcp-foundation.md` — the planning source

No doc states which one owns it. `docs/prd-opencode-mcp.md` is the natural owner of the *decision
content* (ADR-0053 already declares itself derived from it: "via a planning pass … filed as PRD
#38"), and `decisions.md` should own the *decision of record*. Everything else should link, not
restate.

This is not hypothetical drift — it has **already happened once inside this same PR**. Compare:

| Claim | `decisions.md` ADR-0053 §4 | `CONTEXT.md` `post-pass` |
| --- | --- | --- |
| post-pass contents | "Verification, lane/added-line scoping, **priority order, volume cap, and confidence→kind**" | "`verifyCitations` + `scopeCommentsToDiff` + `applyHardRules` + `applyConfidenceFloor`" |

The glossary entry — the one place a reader looks up what the post-pass *is* — enumerates four of
the six things ADR-0053 §4 says it comprises. `applyHardRules` internally covers priority order +
volume cap, so the glossary is not wrong, but it is **narrower than the ADR**, which is exactly the
hand-rolled-copy failure mode in miniature. Cheapest fix: have the glossary entry point at
ADR-0053 §4 for the full list.

### B2. `docs/architecture.md` now contradicts `CONTEXT.md`'s new `engine boundary` entry

`docs/architecture.md` was not in ADR-0053 §Ripple's doc list and was not touched:

- **line 10**: "`@warden/core` — **The review engine.** … Owns … **the boss loop** with
  **`dispatch_worker`** tool, the six **worker concerns** …"
- **line 22**: "`warden review` enters the boss loop — an Opus-tier boss reads the det-prior bundle
  and dispatches per-`(file, concern)` workers …"
- **line 26**: "The boss loop, det priors, and citation verifier are three explicit phases"

`CONTEXT.md:259` now says warden is "the **methodology + deterministic tool-provider**" and an MCP
client "is the execution engine". `docs/architecture.md` is the doc `CLAUDE.md` points an agent at
first ("Monorepo layout, package boundaries, how the pieces coordinate"), and it is now the first
thing a reader hits that says the opposite of the pivot.

Nuance in warden's favour: ADR-0030's amendment is careful — the boss loop is **not deleted**, it
stays as the reference implementation and parity baseline. So `architecture.md`'s *code-ownership*
claims are still true; its *execution-path* framing is what's stale. That distinction is exactly
what makes the staleness easy to miss and worth fixing.

**Fix:** a short pivot note on `docs/architecture.md` (one paragraph near line 10) saying Phase 2
is no longer warden's primary path per ADR-0053 and remains as the parity baseline. `docs/conventions.md`
and `CLAUDE.md` needed no changes — verified, neither mentions the boss loop, Phase 2, or the engine
boundary.

### B3. `CONTEXT.md` §6 gained five nouns that belong in §8 "Deferred concepts"

`CONTEXT.md`'s §6 is titled **"Architecture invariants"** and every pre-existing entry is a *rule
that must hold* (I/O-pure core, package boundaries, config layering, provider readiness, one-shot
CLI). The five new entries are **definitions** — and of things that **do not exist yet**. The
milestones row this same PR adds says so explicitly: "**Zero implementation code exists**".

`CONTEXT.md` already has the right home for this: §8 "Deferred concepts — Named shorthand for
things not yet built." `lane`, `motion`, and `post-pass` all describe client-runtime constructs
with no implementation, a fixed `lane` shape that no code returns, and a `post-pass` **host the ADR
itself says is unfixed**. Filing them as *invariants* overstates their status in the one section a
reader treats as settled.

**Fix:** move `lane` / `motion` / `post-pass` to §8 tagged `[deferred, ADR-0053 pivot]`; keep
`engine boundary` and `state authority` in §6, which genuinely are invariants.

### B4. `CONTEXT.md` "Open inconsistencies" (line 363) did not gain `lane` vs `worker`

That section exists precisely to catch this: "Things the docs spell more than one way. Pick one
before they ossify." The pivot adds a **fourth** spelling of the LLM-call unit:

- `sub-agent` — retired in M14 (CONTEXT.md §5)
- `worker concern` — ADR-0030's per-`(file, concern-subset)` dispatch unit (CONTEXT.md §5)
- **`lane`** — ADR-0053 §6 / new `CONTEXT.md` §6 entry
- and `motion` — the method-level axis above a lane

The new `motion` entry *does* disambiguate motion-vs-worker ("Distinct from ADR-0030's
per-`(file, concern-subset)` worker…"). But **nothing disambiguates `lane` from `worker`**, and the
sweep explicitly puts them in play together: ADR-0030's amendment says worker dispatch "move[s] out
to the external MCP client's lanes", and ADR-0053 §8 says Lever D's "structural worker" is re-homed
as a "client-side **up lane**". Same object, two names, one pivot — exactly the condition that
section was created for.

**Fix:** one bullet — prefer **lane** for a client-runtime agent, **worker** for a warden
phase-2 dispatch unit, **motion** for the method axis; tolerate `worker` in ADR-0030's historical
prose.

### B5. `to-issues/opencode-mcp-00-adr-sweep.md` — every acceptance checkbox is unchecked, though this PR *is* that slice

All eight ACs are `- [ ]`, including ones this diff demonstrably satisfies ("New ADR lands in
`decisions.md`", "`CONTEXT.md` gains the new nouns", "`docs/milestones.md` records the pivot status",
"`to-issues/README.md` blocker column reconciles slice #39", "Zero runtime code changes"). #49 is
**`[CLOSED]`** on GitHub. The slice file — its own acceptance checklist — reports zero progress on
the work it describes, and that file is the thing a future agent opens to learn what the sweep
covered.

Cheap fix: tick the satisfied boxes, and note the one that is **not** satisfied —
"ADR-0016 #3 marked de-deferred and cross-linked to #45" *is* satisfied (the ADR-0016 amendment
does cite `to-issues/opencode-mcp-07-index-export-import.md`, verified to exist), so all eight
actually hold once ticked.

### B6. `ADR-0051 §5` mandates "independent unit tests"; ADR-0053 mandates "no new framework"

code-style §5 in one line: *"A test that mirrors the SUT … cannot fail when the SUT is wrong."* The
repo's answer is `smoke-*.mts` and no unit-test framework, and ADR-0053's Eval gate says so
explicitly ("New seams, **no new framework**"). But ADR-0051 §5 — unamended by this sweep —
requires Lever C to "land with **independent unit tests** first", and ADR-0051's Alternatives
rejects option (5) "Ship C with no independent tests, only via D" on exactly that ground.

The ADR-0051 amendment (line 2900) re-scopes *where* C ships but never reconciles the test
obligation. Worse, it moves C into the **client runtime**, where warden's `smoke-*.mts` convention
and `pnpm smoke:*` wiring do not reach — so "independent unit tests" now has neither a framework nor
a home. This is a real unclosed §5 hole the sweep should have caught, and it's cheap to close:
amend ADR-0051 §5 to say which observable (a client lane emitting a mixed-lane finding that survives
`verifyCitations`) is asserted, and in what harness.

### B7. Two explanations for the same ADR-number gap

- `to-issues/opencode-mcp-00-adr-sweep.md` AC: "at the next free number (0050 is skipped, 0052 is
  the current max → **0053**)"
- ADR-0053 §Status: "Takes the next free number (**0053**; **0050 was renumbered into ADR-0049's
  bound set**)"

Both explain the gap from `0050`; they give different reasons (reserved-and-unwritten vs
renumbered), and the file also says "0052 is the current max" when ADR-0051 exists in the tree
(verified at `decisions.md:2850`). Harmless today, but the slice file is the reference a future
agent reads before adding ADR-0054.

### B8. `to-issues/README.md` — the two tables now disagree about levers B/C/D

The new prose (line 42) says "File the remaining recall levers (B/C/D) **through that ADR sweep, not
as separate slices here**." The first table (lines 18–20) still lists them as separate tracked
issues:

```
| [intent-context-for-review](./intent-context-for-review.md)               | #30 | high (recall)     | yes — lever B |
| [lane-discipline-cross-file-evidence](./lane-discipline-cross-file-evidence.md) | #31 | medium (recall) | yes — lever C |
| [structural-ceiling-pass](./structural-ceiling-pass.md)                   | #37 | high (recall + precision) | proposed ADR-0052 — lever D |
```

All three are `[OPEN]` (verified via `gh`). They're reconcilable — "don't file *new* ones" vs
"already filed" — but the README never says so, and #37's `Needs ADR?` cell still reads
"proposed ADR-0052" when ADR-0052 is now *re-scoped* by ADR-0053 §8. Also: README line 38 says the
prerequisite "precedes slice 1" in the present tense while #49 is closed.

### B9. Milestones pivot row heading excludes the gate slice

`- [ ] **OpenCode MCP pivot — in planning, slices #39–#48**` — but the body then opens
"Slice order: **#49** ADR sweep (gate, landed as ADR-0053 + amendments)". The heading drops #49,
the body includes it, and ADR-0053 §Locus says `#39–#48` while §Status says #49 was filed
separately. Three places, two ranges. Pick one (`#38–#49`, or "slices #39–#48 + ADR gate #49").

---

## C. Verified clean

### C1. Amendment placement — all 8 amendments sit **inside** their ADR sections

Enumerated programmatically by walking `decisions.md` and tracking the enclosing `## ADR-` heading:

| line | enclosing ADR | amendment header |
| --- | --- | --- |
| 193 | ADR-0005 | AI SDK retained, lane model calls leave warden |
| 448 | ADR-0016 | §10 de-defers §3 (`index export\|import`) |
| 555 | ADR-0017 | cascade's dominant caller set leaves warden |
| 1822 | ADR-0030 | Phase 2 leaves, Phase 1 + Phase 3 stay |
| 2389 | ADR-0039 | hosted surface may shrink |
| 2772 | ADR-0048 | §7 observability re-homing |
| 2900 | ADR-0051 | §8 sourcing policy moves, verification layer stays |
| 2988 | ADR-0052 | structural lane leaves, deterministic tells stay |

Every one sits **after** its ADR's `**Status.**` paragraph and **before** the section boundary — the
file's existing convention. No orphaned amendment. (Note: `decisions.md` uses *blank-line* boundaries
between ADR sections, not `---` — I checked all 52 `## ADR-` headings and none is `---`-delimited, so
ADR-0053's placement at line 2990 is consistent. Reporting this because it looked like a violation on
first read.)

The amend set exactly matches the table the sweep was scoped against (slice-00 "Amend / reopen":
0030, 0005/0017, 0048, 0039; "Re-scope": 0051/0052; "De-defer": 0016 §3) — **8 blocks, 8 targets, no
misses.** The slice-00 AC "Every ADR in the amend table carries an explicit amendment note. None is
left silently contradicted" is met for the amend table.

### C2. Every relative link introduced by the diff resolves — except A2

Programmatic check of every `[...](...)` on added lines, resolved from each file's own directory:

| file | link | resolves |
| --- | --- | --- |
| `docs/milestones.md` | `../blob/main/decisions.md` | ❌ `blob/main/decisions.md` — **A2** |
| `docs/milestones.md` | `./prd-opencode-mcp.md` | ✅ |
| `docs/milestones.md` | `./opencode-mcp-foundation.md` | ✅ |
| `docs/milestones.md` | `../m18-plan.md` | ✅ |
| `to-issues/README.md` | `./opencode-mcp-00-adr-sweep.md` | ✅ |
| `to-issues/README.md` | `./opencode-mcp-01-mcp-server-skeleton.md` | ✅ |
| `to-issues/README.md` | `../docs/prd-opencode-mcp.md` | ✅ |
| `to-issues/README.md` | `../docs/opencode-mcp-foundation.md` | ✅ |
| `to-issues/opencode-mcp-00-adr-sweep.md` | `../docs/prd-opencode-mcp.md` | ✅ |
| `to-issues/opencode-mcp-00-adr-sweep.md` | `../docs/opencode-mcp-foundation.md` | ✅ |

`to-issues/opencode-mcp-00-adr-sweep.md` exists (added by this diff) ✅.

### C3. Every GitHub issue number referenced exists in `99Yash/warden`

`gh issue view <n> --repo 99Yash/warden` for every `#NN` in the diff:

| # | state | title |
| --- | --- | --- |
| 30 | OPEN | Feed stated intent … — lever B |
| 31 | OPEN | Let a finding cite an unchanged out-of-diff consumer — lever C |
| 32 | CLOSED | Wire ADR-0048 observability |
| 33 | OPEN | Resume / per-worker output cache |
| 37 | OPEN | Ratify Lever D: structural / "ceiling" review pass |
| 38 | OPEN | PRD — Warden as MCP tool-provider for OpenCode |
| 39 | OPEN | MCP server skeleton + `lookup_type_def` |
| 40 | OPEN | `run_det_priors` MCP tool + versioned bundle |
| 41 | OPEN | Mandatory post-pass outside the model |
| 42 | OPEN | OpenCode lane config + prompt materialization |
| 43 | OPEN | Tracer-bullet eval + parity gate |
| 44 | OPEN | `search_index` MCP tool |
| 45 | OPEN | `warden index export/import` verbs + CI cache recipe |
| 46 | OPEN | Structural `up` lane + deterministic tell-collector |
| 47 | OPEN | State authority + review-trace bridge |
| 48 | OPEN | CI runner: Action + cost cap + PR output + cached index |
| 49 | **CLOSED** | ADR sweep: lock Warden-as-tool-provider + re-scope the ADRs the pivot breaks |

All 17 exist, none is a phantom reference. #49 closed matches the milestones row's "landed as
ADR-0053 + amendments". ✅

### C4. Every file path / symbol referenced resolves

| reference | status |
| --- | --- |
| `packages/core/src/indexing/interfaces.ts` | ✅ exists |
| `packages/core/src/review-harness/det-priors.ts` | ✅ |
| `packages/core/src/review-harness/comment-scope.ts` | ✅ |
| `packages/core/src/review-harness/harness.ts` | ✅ |
| `packages/cli/src` | ✅ |
| `packages/cli/scripts/eval/` | ✅ |
| `docs/reference/structural-review.md` | ✅ |
| `docs/reference/structural-review-profiles.md` | ✅ |
| `docs/prd-opencode-mcp.md`, `docs/opencode-mcp-foundation.md` | ✅ |
| `to-issues/opencode-mcp-07-index-export-import.md` (ADR-0016 amendment) | ✅ |
| `to-issues/opencode-mcp-{00..10}` | ⚠️ 11 files exist; shorthand is not a path — **A2/A3** |

**Correction to the brief's premise:** the brief asked me to verify ADR-0053's references to
`verify-citations.ts` and `confidence.ts`. **ADR-0053 does not reference either by path**, and
neither path was introduced by this diff. The `verify-citations.ts:64` / `harness.ts:192` citations
appear in ADR-0049/0051's **pre-existing, unamended** Status prose. For the record, the real
locations are `packages/core/src/llm/verify-citations.ts` and `packages/core/src/confidence.ts` —
note **not** under `review-harness/`, so anyone extending those old `file:line` refs from the
wrong directory will miss.

**Every symbol the diff names exists** (grep across `packages/`, excluding `node_modules`/`dist`):

`verifyCitations` (12 files) · `scopeCommentsToDiff` (4) · `applyHardRules` (5) ·
`applyConfidenceFloor` (4) · `runDetPriors` (10) · `runReviewHarness` (11) · `SqliteIndexExporter` (5) ·
`SqliteIndexImporter` (4) · `renderBossUserPrompt` (1) · `ConcernEnum` (2) ·
`dispatch-worker.ts` · `run-worker.ts` · `boss-loop.ts` ✅

And the six concerns ADR-0053 §6 / CONTEXT.md re-tax are exactly
`ConcernEnum = z.enum(["correctness","scalability","consistency","security","committability","leverage"])`
at `packages/core/src/review-harness/tools/dispatch-worker.ts:31`. ✅

### C5. Markdown table integrity — `docs/milestones.md` rows are clean

`milestones.md` is a **bullet list**, not a table — the three new/changed rows (pivot, M18, M19+) each
contain **0** pipe characters, so there is nothing to mis-split. Column alignment is N/A.
The added `**[Re-scoped by ADR-0053]**` clauses are appended in-line and don't disturb the checkbox
`- [ ]` / `- [x]` prefixes or the `   - **BYOEmbedder**` sub-bullet nesting under M19+.

`to-issues/README.md`'s new slice-00 row: 3 cells, no unescaped `|` in the cell text (the
`tool-provider + re-scoped ADRs` label has none), separator row intact. ✅

`decisions.md`'s snapshot row is the **only** table-integrity defect — see A1.

### C6. Repo gates — clean, as expected for a docs-only diff

```
$ pnpm check-types
 Tasks:    6 successful, 6 total          # 0 errors / 0 warnings / 0 hints (@warden/web)

$ pnpm lint
> oxlint
Found 0 warnings and 0 errors.
Finished in 17ms on 188 files with 95 rules using 10 threads.
```

**Both gates pass and neither flags anything this diff should have fixed.** This diff contains no
`.ts`/`.mts` file, so `check-types` and `oxlint` are structurally incapable of seeing it — a clean
result here is the *expected* result and is **not** evidence the docs are correct. It is reported as
a non-finding. The two real defects this review found (A1, A2) are invisible to both gates, which is
precisely why a docs sweep needs its own link/table check.

---

## D. nits

- **`to-issues/opencode-mcp-00-adr-sweep.md` has no trailing newline** (`\ No newline at end of
  file`; last byte `0x2e` = `.`, vs `0x0a` for all five sibling files). Every other file in the diff
  ends with `\n`.
- **ADR-0053 §6 attributes `judge` to the wrong source.** It reads "the three motions from
  `docs/reference/structural-review.md` — up, down, surface — **plus `judge`**". `judge` is *not* in
  that file (it has three motions; synthesis lives in its "Summary pass" §). `judge` is a PRD-level
  decision — `docs/prd-opencode-mcp.md:177-178`: "the three motions from the structural-review method
  **plus the judge**". Since ADR-0053 §9 makes these docs the *generation source* for client agent
  definitions with a CI drift check, mis-attributing a fourth motion to the generator input is worth
  fixing before that generator exists. Same imprecision in `CONTEXT.md`'s `motion` entry.
- **ADR-0053 §Locus drops the PRD's conditional fourth tool.** PRD line 158-161 lists `run_det_priors`,
  `search_index`, `lookup_type_def` **plus** "`build_intent` … included only if Lever B survives the
  pivot." ADR-0053 §Locus names only the first three, with no trace of `build_intent`. Probably
  deliberate (Lever B is ADR-0049, still *proposed, not owner-ratified*) — but the ADR should say so
  rather than silently omitting it.
- **`CONTEXT.md` §8 `cloud-hosted index + sync`** (line 309) says "The hosted-mode swap point named in
  ADR-0016" — while ADR-0053 §10 rejects a hosted store for this pass and rejects libSQL/Turso in
  Alternatives (5). Not a contradiction (deferred ≠ rejected-for-this-pass) but a reader arriving
  via §8 gets no pointer to ADR-0053's narrowing.
- **ADR-0031 gets no amendment.** It's not in the amend table, so the sweep is technically complete —
  but ADR-0031 (M15) exists to calibrate *the boss loop*, which ADR-0053 sheds. ADR-0053 reuses the
  M15 harness as the parity gate without noting that its original purpose (loop calibration) is
  superseded. One `**Amendment**` line would close it.

---

## E. The 10-item high-signal hit-list, item by item

code-style.md's closing list, marked for a docs-only diff.

| # | Pattern | Verdict |
| --- | --- | --- |
| 1 | Local shape duplicating a Drizzle table or zod schema → derive it | **N/A (mechanism)** — no schema. **HIT (analogue)** — the pivot description is hand-copied across 7 docs with no owner → **B1**. One instance of drift already materialized (post-pass contents) → **B1**. |
| 2 | Full error object logged → leaks secrets/PII | **N/A** — no logging. |
| 3 | External/LLM call with no timeout or `abortSignal` | **N/A** — no code. (Noted: ADR-0053 §11 introduces the CI runner that makes model calls, and its *own* ceiling requirement — the hard spend cap — is stated. No finding.) |
| 4 | New endpoint missing rate-limit / auth coverage | **N/A** — no endpoints. `warden mcp` is stdio, not a network endpoint; ADR-0053 §2 correctly rejects the hosted-API alternative (2) partly on auth/billing surface. |
| 5 | Silent `catch` with no user feedback | **N/A** — no code. ADR-0053 §5(c) *requires* structured degraded results rather than throwing, which is the right instinct for the seam. |
| 6 | **Duplicated logic representing one co-changing domain truth → centralize it; leave coincidental similarity separate** | **REAL HIT.** This is the one list item written for facts rather than code, and it is the governing rule for this diff. The pivot's canonical description is duplicated 7× with no owner → **B1**. The "co-changing" test passes: the ADR, the glossary, the milestones row and the slice-00 file all currently disagree on the slice range (`{01..10}` / `#39–#48` / `#00..10` / `#49`) → **A3, B9**. |
| 7 | Non-exhaustive switch over a union → `never` check | **N/A** — no code. |
| 8 | `useEffect` after unmount / wrong deps | **N/A** — no React. |
| 9 | Webhook HMAC against re-parsed body | **N/A** — no webhooks. |
| 10 | Unbilled `Promise.all` after a sibling fails | **N/A** — no code. |
| 11 | Tautological test | **APPLIES to claims** — see §E2 below. |

### E2. code-style §5, applied to the test claims this diff *makes*

The diff adds no test files, so there is nothing to be tautological. The rule still bites, because
ADR-0053 asserts what future tests must prove. Checked each claim for "can this fail when the
implementation is wrong?"

- ADR-0053 Eval gate (a): "speak the protocol against a spawned server, assert **discovery, result
  envelope, size bound, version field, degraded behavior**" — five observable outcomes against a
  real spawned server. **Behavioural. Passes.** Notably it pins *size bound* and *version field*,
  which are the two properties §5 makes load-bearing; a literal-pin-without-policy test would not
  catch a regression where the envelope grows unbounded.
- ADR-0053 Eval gate (b): "the **reused** eval harness as the parity gate" with `*-misses-*` /
  `*-falsepos-*` fixtures and the existing threshold scorer — a **cross-source agreement** oracle
  (client path vs warden baseline), which §5 explicitly names as a legitimate non-tautological form.
  **Passes** — and this is the right call, because a mirrored copy would have been the exact failure
  mode.
- ADR-0053 Eval gate (c): "`smoke-*.mts` for export/import round-trip and bundle serialization, per
  the repo's no-unit-framework convention" — round-trip is the canonical behavioural assertion;
  the file references the repo's real convention rather than inventing a framework. **Passes.**
- ADR-0053 Eval gate: "Scope rules (§4, §7) are asserted **independently of `runReviewHarness`** —
  that independence is the thing being tested." **This is the strongest §5 statement in the diff.**
  An independence assertion *cannot* pass when either side is silently re-coupled, which is exactly
  the failure the pivot introduces. The diff names no tautology escape hatch and pins no unanchored
  literal. **Passes cleanly.**
- ADR-0030 amendment: "what the smoke suite must now assert is that independence (ADR-0053's eval
  gate)." Consistent with the above, and it defers to the ADR rather than restating it. **Passes.**
- ADR-0051 §5: "lands with **independent unit tests** first" — **HIT**, see **B6**. Not a tautology,
  but a test claim the repo has no framework to keep, and one the pivot relocates out of reach of
  `smoke-*.mts` entirely.

**Net: the diff makes no test claim it cannot keep, except ADR-0051 §5 (B6).** Everything the diff
*adds* is behaviour-anchored and framework-consistent.

---

## F. Verdict

**Do not merge before A1 and A2.** Both are one-line fixes and both mislead every future reader: A1
corrupts the `decisions.md` status table and commits a tool's truncation string into the repo's
decision record; A2 puts a dead link on the single row the diff tells readers to read first. A3 is
the same class (a cross-reference that points where it claims) and is nearly as cheap.

The ADR work itself is strong. The phase split is stated consistently across all 8 amendments, the
§5 "a model-invoked gate is not a gate" invariant is the right load-bearing constraint and is
restated consistently in ADR-0053 §4, ADR-0030's amendment, and CONTEXT.md's `post-pass` entry. The
amend set is complete against its own scope table. Every path, symbol, and GH issue number resolves
(C3, C4) — the failure mode here is not wrong references but *absent* ones (A2, A3) and one
*committed* corruption (A1).

The substantive follow-up is **B2**: the sweep enumerated the docs it would update, and
`docs/architecture.md` — the doc `CLAUDE.md` routes agents to first — was not on that list while
still calling `@warden/core` "The review engine". B1/B3/B4 are the same shape at smaller scale: the
pivot is now a fact with seven partial restatements and no named owner, and the glossary entry that
should be the canonical short answer is narrower than the ADR it summarizes.

**Findings: 3 must-fix, 9 follow-up, 5 nits.**
