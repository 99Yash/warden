# PR #50 — round 0, down-pass

**Verdict: changes requested on the decision record, not on runtime code.** Four load-bearing claims need correction: the independently-callable gate inventory, lane-discipline ownership, completeness of the portable index, and placement of confidence→kind demotion. The proposed pivot is not itself falsified; the claim that its deterministic guarantees can be preserved merely by re-hosting the existing Phase 3 is.

## Scope and method

- Read `/Users/yash/Developer/self/alfred/docs/reference/structural-review.md` in full. Ran only down-proof: no up-pass or surface-style review.
- Compared `1a4ab32c211eaa256e413580b17f130de29f9d82...HEAD`: six authored documentation files, 181 insertions / 5 deletions, no runtime change. Reviewed the facts grounding the proposed contracts, not hypothetical missing implementation as if this PR shipped it.
- Depth was earned by ownership changes over precision gates and authoritative persisted state. Invariant: given client-produced findings and a restored index, moving execution out of Warden must not make existing deterministic precision controls optional or corrupt the context cache.
- Through the system: followed exports, input shapes, dispatch filtering, final verification, rule application, persistence, and index consumers. Through time: examined export→restore→reconcile/prune and dispatch→verify→submit sequences. Down to authority: used actual function bodies, SQLite schema/SQL, package exports, and Git history rather than ADR assertions.
- The requested `packages/core/src/llm/tools/dispatch-worker.ts` does not exist. The authoritative implementation is `packages/core/src/review-harness/tools/dispatch-worker.ts`.

## Findings requiring correction in this docs-only PR

### D1 — `must-fix`: the complete post-pass is not independently callable today

**Changed claims:** `decisions.md:1826`, `decisions.md:3000`, and the corresponding `CONTEXT.md:265` inventory.

The logical separation is mostly real, but the stated callable seam is incomplete:

- `verifyCitations` is exported from `packages/core/src/index.ts:43-47`. Its function (`llm/verify-citations.ts:64-122`) owns a per-call cache and consumes only comments + repo root. It does not reach into harness/scratchpad state. It does read the current filesystem, so equivalence assumes the same checkout is retained through verification.
- `scopeCommentsToDiff` (`review-harness/comment-scope.ts:17-37`) consumes comments + `ChangedFile[]` and has no ambient state. It is exported from its module and accessible via the package's wildcard subpath export (`packages/core/package.json:4-7`), but is not re-exported at the root.
- `applyConfidenceFloor` (`confidence.ts:43-64`) is root-exported and independent of the scratchpad. Its effective policy uses validated environment configuration unless an explicit security-floor override is supplied (`confidence.ts:82-104`).
- **`applyHardRules` is a private lexical function**, not an export (`packages/core/src/index.ts:440-475`). No subpath import makes that private declaration callable. Its existing independent check-mode caller is inside the same module (`index.ts:403`), not an external post-pass host.
- Worse, the complete deterministic gate set named in ADR-0053 §4 is not the implementation of that private function. It sorts, applies the existing drop-floor, and filters Tier 3. It **does not enforce a volume cap or compute confidence→kind demotion**. `run-worker.ts:330-338` explicitly says demotion is currently a prompt instruction, not ADR-0044's deterministic post-pass. `schema.ts:107-121` has no public `Comment.evidence` field; `verifyCitations` checks source triples, not mandatory evidence on every finding.

**Counterexample:** precondition: #41 implements the documented post-pass as a client of core, without the boss harness. Event order: import the listed functions → apply them to more than five valid correctness findings or a low-confidence reasoned assertion. Failure point: `applyHardRules` cannot be imported; copying its current body would still neither cap the output nor demote the assertion. Resulting state: the alleged existing gate suite is not callable and does not enforce two of the promised controls. Consequence: the implementation brief understates actual core work and can certify a weaker precision boundary as a re-hosting.

**Requested doc correction:** say the individual verifier/scoper/floor are separable, but #41 must expose/extract a composed core post-pass and implement the still-deferred ADR-0044 evidence/demotion/volume semantics. Do not imply the evidence-field migration is already shipped or simultaneously promise unchanged `CommentSet` shape without acknowledging it. This is a bounded extraction/migration, not evidence that the whole pivot needs a rewrite.

**Conclusion: broken.**

### D2 — `must-fix`: lane discipline is a deterministic Phase-2 mechanism, not an existing Phase-3 gate

**Changed claims:** `decisions.md:2905` (“post-pass still sees the dispatched lane set”), `decisions.md:3000`, `decisions.md:3006`.

The current execution order is authoritative:

1. `dispatch-worker.ts:319-346` constructs `new Set(args.files)` and calls the private `commentInLane` helper (`:392-401`) **inside worker dispatch, before scratchpad recording and boss synthesis**.
2. `harness.ts:192-196` verifies the boss's final comments, then scopes anchors against `detPriors.changed`.
3. `verifyCitations` sees only comments + repo root; `scopeCommentsToDiff` sees only comments + the whole changed-file set. Neither receives worker-dispatch files or a lane identity.
4. `CommentSchema` (`schema.ts:107-121`) and the dispatched `Comment[]` do not preserve the originating dispatch's file set. That context lives in `WorkerOutput`/scratchpad and dispatch arguments.

**Counterexample:** precondition: a behavioral lane is dispatched against changed `a.ts`; `b.ts` is another changed file outside that dispatch. Event order: the lane emits a finding anchored to an added line in `a.ts` whose only snippet source cites real `b.ts` → dispatch filtering is shed with Phase 2 → the documented existing Phase-3 functions run. Failure point: global verification accepts `b.ts`, added-line scoping accepts the `a.ts` anchor, and no function checks membership in `{a.ts}`. Resulting state: a finding the old dispatch gate rejects reaches the canonical result. Consequence: the behavioral lane discipline ADR-0051 explicitly preserves is weakened despite the claim that positional computation remains untouched.

This is not a criticism that #41 is unimplemented. It falsifies the grounding assertion that its needed lane state and filter already belong to the retained phase. No OpenCode hook can recover discarded dispatch context merely by intercepting terminal output.

**Requested doc correction:** explicitly retain/extract the deterministic lane filter from Phase 2; specify that the host carries trusted per-finding lane/file-scope association into the post-pass, including synthesis/merge behavior. Distinguish the client's cross-file sourcing **judgment** from Warden's non-discretionary membership **filter**. “Only Phase 2 leaves” needs this exception.

**Conclusion: broken.**

### D3 — `must-fix`: exporter/importer exist, but “only verbs and the CI recipe are new” is false

**Changed claims:** `decisions.md:448`, `decisions.md:3018`, `to-issues/opencode-mcp-00-adr-sweep.md:38-40`.

Existence and exports are established: `indexing/index.ts:30-31` and `core/src/index.ts:115-116` re-export both implemented classes. There is no literal TODO/throw-not-implemented stub. CLI registration (`packages/cli/src/index.ts:195-248`) contains check/review/security/setup/init, not index export/import.

However, these are M6 archive implementations that do not round-trip the current M16 index:

- `exporter.ts:24-28` writes a manifest containing **only** `formatVersion` and `exportedAt`. Locked model and Merkle root are separate meta records (`:30-38`), not manifest fields as claimed.
- Export emits meta/chunk/embedding/merkle records, **never `file_chunks`** (`:30-75`). Import likewise has no `file_chunks` record handler or restore (`importer.ts:48-124`). `ExportCounts` does not include that table (`interfaces.ts:174-179`).
- That table is the authoritative many-to-many mapping (`packages/db/src/schema/file-chunks.ts:4-18`), not expendable cache garnish.
- Export copies the `file_chunks_backfilled_at` meta marker. `file-chunks-store.ts:118-126` then refuses backfill on restore. Orphan pruning deletes every chunk unreferenced by the omitted table (`:103-113`). `reconcileFiles` invokes backfill and prune (`init/reconcile.ts:112`, `:271`), including when refreshing only a stale subset.
- Manifest versions are ignored (`importer.ts:49-51`), malformed JSON is silently skipped (`:43-46`), and replace deletes the destination before parsing, without an encompassing restore transaction (`:29-39`). No locked-model mismatch validation is present. These are substantive restore/validation requirements for #45, not CLI plumbing.

**Counterexample:** precondition: a normal M16 index has one shared content hash owned by `a.ts` and `b.ts`, embeddings, and the backfill marker. Event order: export → import into a fresh CI database → first stale-subset reconcile. Failure point: the authoritative junction was not serialized, while the imported marker suppresses recovery. Resulting state: unchanged-file chunks have no ownership and the existing orphan-prune deletes them and their embeddings. Consequence: CI can lose the expensive restored corpus and miss shared-file attribution; subsequent reviews may have to re-embed it. Even a restore that happens not to reconcile can only use `semantic.ts:151-156`'s first-writer `chunks.filePath` fallback, losing the second owner's attribution.

**Requested doc correction:** record that #45 extends/versions and validates the archive, restores `file_chunks`, handles locked-model compatibility, and proves authoritative ownership preservation—not merely that semantic search returns at least one hit. Keep “the classes already exist,” remove “only verbs/recipe.”

**Conclusion: broken.**

### D4 — `must-fix`: the ADR-0052 amendment moves a deterministic transform into prompt discretion

**Changed claims:** `decisions.md:2988` versus ADR-0053 §4 (`:3006`) and retained ADR-0044 §6 (`:2539-2543`).

The new amendment says §3 admissibility, **§4 ladder→confidence→kind demotion**, and §6 forcing function “become the client lane's prompt contract.” There are two distinct authorities here: the model judges the available enforcement tier and assigns confidence; a deterministic post-pass turns that confidence/provenance into output `kind`. ADR-0044 explicitly locates the latter in `applyHardRules`; ADR-0053 §4 explicitly keeps confidence→kind outside model discretion. The new amendment does not preserve that distinction.

**Counterexample:** precondition: #46 follows the new amendment literally and relies on the structural prompt for demotion, reusing existing post-pass bodies. Event order: a client returns a 0.5-confidence `clarity` assertion for a convention-only closure → verified snippets and added-line anchor pass → current floor has no clarity entry (`confidence.ts:20-22`) → current hard rules never change `kind`. Failure point: only the model was asked to demote. Resulting state: the weak structural proposal posts as an assertion. Consequence: the deterministic precision promise survives in §4 prose but not in the ownership contract implementers follow.

**Requested doc correction:** move only ladder assessment/admissibility judgment/forcing-function prompts to the client; expressly keep confidence/provenance→kind computation in Warden's mandatory post-pass, with the ladder-fidelity gate still required. This also resolves the contradiction with ADR-0044 rather than silently reopening it.

**Conclusion: broken.**

## Required factual checks that close narrowly

### Phase 1 has a real independent entry point

Evidence: `runDetPriors` (`det-priors.ts:102-504`) imports no scratchpad/boss-loop state; it returns its complete phase output. Root export is `core/src/index.ts:140-150`; `runCheck` calls it directly (`:359-367`). `harness.ts` passes its result into a newly constructed scratchpad only afterward (`:144-145`).

Assumptions: environment and DB initialization are available; repo root/diff refer to the intended tree. It is not mathematically pure or free of effects: it may write `.gitignore`, refresh SQLite, run subprocesses, call OSV, and spend on embeddings. No claimed independence from those resources was proven. Importing its root export also loads harness/provider modules; independence here means no boss execution/state requirement, not a dependency-free distribution.

**Conclusion: closed within scope.**

### The four store interfaces really are asynchronous

Evidence: every method in `ChunkStore` (`interfaces.ts:16-25`), `EmbeddingStore` (`:34-50`), `MerkleStore` (`:69-82`), and `FileChunksStore` (`:91-131`) returns a `Promise`. No synchronous member was found in any of these four contracts.

Assumption: this closes the **signature** claim only. It does not prove all indexing consumers are transport-neutral.

**Conclusion: closed within scope.**

### Six concerns and unchanged output category/priority taxonomy

Evidence: `review-harness/tools/dispatch-worker.ts:31-38` contains exactly correctness, scalability, consistency, security, committability, leverage. `schema.ts:28-47` defines the larger output `CategoryEnum`; `core/src/index.ts:413-427` owns `PRIORITY_ORDER`. Neither file is changed by this diff. ADR-0052's existing Locus (`decisions.md:2943`) explicitly routes structural findings to existing clarity/dedup rather than adding a structural category.

Assumption: “untouched” means this decision/document diff does not change those contracts; future orchestration still has to preserve their semantics. This does not prove the four client agents exist.

**Conclusion: closed within scope.**

### MCP implementation and the predecessor commit

Evidence: source/manifests/lockfile search found no live `modelcontextprotocol` dependency or MCP implementation; CLI commands are registered at `packages/cli/src/index.ts:195-248` with no `mcp` command. A tracked-text search **does** find `@modelcontextprotocol/sdk` inside the borrowed alfred PR fixture at `packages/cli/scripts/eval/fixtures/real-prs/alfred-pr14-misses-1ff9057/diff.patch:12858,12875` and the explicit exclusion in `scaffolding-plan.md:252`. Those are data/documentation, not Warden dependencies.

`git show --stat 1a4ab32` reports 13 planning-doc/ticket files, 889 insertions; no runtime files. This PR's own stat reports exactly the six docs named in the request. “Zero pivot implementation code” is accurate; it must not be read as “this repo has no existing security/review code.”

**Conclusion: closed within scope.**

### 0053 is the next available ADR number

Evidence: existing full entries stop at 0052; ADR-0049 Bound (`decisions.md:2840`) reserves 0050 for init-time repo-intent and 0051 for Lever C, which now has a draft full entry. 0053 collides with neither.

Assumption: reservations in this file are authoritative for numbering.

**Conclusion: closed within scope.**

### “Deterministic gates are NOT MCP tools” is internally consistent as a transport decision

Evidence: ADR-0053 §4, Why, Alternatives(3), and `to-issues/opencode-mcp-03-mandatory-post-pass.md:9-27` consistently prohibit exposing post-pass gates as model-invoked tools. Proposed MCP handlers at `decisions.md:3022` are det-priors/search/type lookup, not verifier/scoper/hard-rule tools. A plugin used as the **post-pass host** is explicitly distinct from a proprietary plugin **tool-provider seam** (`:3045`). Exposing deterministic detectors in Phase 1 does not contradict prohibiting model-discretionary final gates.

Assumptions: the claim is limited to the adopted protocol contract, not an implemented guarantee, and “gate” here means final output-enforcement rather than every conditional anywhere in the index pipeline. D2/D4 remain contradictions in **placement/enforcement**, not evidence that a verifier MCP tool is secretly proposed.

**Conclusion: closed within scope.**

## Process and implementation follow-ups

### F1 — `follow-up`: the non-discretionary host guarantee is deliberately unproven

**Claim:** every publishable review necessarily crosses the post-pass, even when the model omits terminal submit, returns malformed output, fails, or emits no findings.

There is no plugin, review driver, terminal interception probe, or protected publishing path in this repo for the client path. Current authority is the direct imperative chain `harness.ts:173-196` followed by `index.ts:267-278`; the existing boss's SDK-validated terminal tool is specific to its in-process loop (`boss-loop.ts:506-565`). Porting tool calls does not port that control flow. The driver's strength depends on whether it owns **publication**, not on whether it happens to execute after a session: a driver that can only publish the post-pass result can enforce this architecturally; a human/CI checklist that posts raw session text cannot.

Repo-specific weakening factors beyond the hook question:

- D1/D2 show the needed deterministic functions and lane state are not one closed public boundary today.
- `verifyCitations:71-76` passes zero-snippet findings through; `CommentSchema` permits empty sources and has no required evidence. Host invocation alone does not establish evidence honesty.
- `comment-scope.ts:39-43` deliberately lets `0:0` file-level anchors pass whenever the file is changed, without added-line overlap. Preserve or explicitly decide this exception; do not call the inherited policy strict overlap on every finding.
- `reviewRuns` stores coarse counts/models/tokens, not the canonical comments or per-finding trace (`packages/db/src/schema/review-runs.ts:22-43`). Writes are best-effort (`harness.ts:376-401`) and the post-hard-rules count update silently fails (`:413-418`). `inputHash` is deliberately non-unique. Thus the ADR-0048 amendment's “run-id/input_hash ... prevents two records ... diverging” (`decisions.md:2774`) is not an existing enforcement mechanism; the ADR-0053 caveat correctly admits the authority rule is by fiat.
- Drop events are not all currently post-pass events: lane and uncited drops occur in `dispatch-worker.ts:338-345` and `run-worker.ts:278-285`. “Dropped-candidate events stay because the post-pass is where findings actually get dropped” (`decisions.md:2779`) requires deliberate re-homing, not automatic preservation.

**Missing evidence:** a host/publisher integration probe covering skipped submit, empty success versus client failure, parse/verification failure, cancellation, and raw-output bypass; a trusted lane envelope; a specified durable-record/telemetry boundary. Risk: a client path can post unchecked findings or report execution failure as a clean review, while telemetry looks like a run.

This is a follow-up, not a demand to implement OpenCode in a docs PR: the caveat and #41 acknowledge the missing proof, #42 depends on #41, and #43 gates the default/CI path. This uncertainty is acceptable only while that cutover remains blocked; it is unacceptable for the runtime default without the proof. Clarify publication ownership and require failure-path probes in #41.

**Conclusion: unproven.**

### F2 — `follow-up`: async interfaces do not establish a drop-in remote-store swap

The narrower async fact closes above. The broader claim still has a substrate gap: `reconcileFiles` calls concrete `commitFileReconcile`/`commitFileRemoval` (`init/reconcile.ts:241-247`, `:264-267`), whose implementations directly use synchronous SQLite cross-table transactions (`:350-440`) rather than the passed stores. It also writes metadata through the concrete SQLite helper (`:292`). `semantic.ts:132` defaults the ownership store to SQLite; `runDetPriors` constructs concrete SQLite stores for refresh/retrieval (`det-priors.ts:174-196`, `:248-255`).

**Missing evidence:** a cross-table commit/meta seam and remote atomicity contract, plus a consumer-level probe. Residual risk: replacing only the Promise-shaped stores splits reads and authoritative writes across backends. ADR-0053 defers remote stores and says “feasible later,” so this is not a demand for a new remote backend. Record this caveat rather than treating async signatures as proof of a swap.

**Conclusion: unproven.**

### F3 — `follow-up`: parity is a planned binding gate, not a ready-made client-path proof

The reusable scorer is real: `eval/score.mts:42-75` uses median recall/cost with max forbidden hits, and `:132-212` implements thresholds. But `eval/run.mts:339-350` always invokes `runReviewHarness`, **not** public `review()`/hard rules or a client adapter. Its dispatch proxy depends on Sonnet/Haiku token buckets (`:590-596`), and missing provider keys exit successfully as a skip (`:612-619`). It does not currently score canonical post-hard-rule output. A zero-key CI “green” is not parity evidence.

**Missing evidence:** #43's client adapter, comparison on equivalent canonical output for both arms, mandatory fixture selection and non-skip completion, client dispatch/cost accounting, and the recorded parity threshold. Residual risk: the acceptance gate compares different output stages or appears green without running. The ADR and `to-issues/opencode-mcp-05-tracer-bullet-eval.md:9-23` correctly allocate future work, so this is not a current-runtime regression.

ADR-0031 remains written around boss-loop configs and dispatch gate (e); it receives **no** amendment here. That is historically intelligible but leaves the reusable assets versus legacy-runner-only knobs implicit. A short amendment should distinguish runner, scorer, and non-skip acceptance semantics. Its M15 materialization limitation is also historical, not blanket current fact: `run.mts:135-213,305-360` now supports real-repo worktrees, with sparse fallback still insufficient for structural whole-tree proof. ADR-0052 already requires reachable `meta.json` fixtures (`decisions.md:2947`).

ADR-0033 similarly retains the old harness-owned semaphore mechanics with no local amendment. ADR-0030's new note (`:1830`) and ADR-0053 Ripple (`:3036`) explicitly transfer caps to the client, so there is no unavoidable contract contradiction; the actual client per-tier limiter remains unproved. Add a local redirect to prevent the old defaults/env names being mistaken for enforcement on external lanes.

**Conclusion: unproven.**

## Small factual corrections

### N1 — `nit`: the existing boss never encoded “fund up first”

**Changed claim:** `decisions.md:1828`.

Precondition: a reader uses this amendment to infer the old loop already supplied the method ordering. Event order: inspect baseline rounds (`prompts/boss-system.md:55-89`) and PD-multi (`boss-loop.ts:427-435`). Failure point: those rounds dispatch behavioral concerns; there is no structural up lane. Resulting state: the reader treats a new sequencing requirement as preservation of an existing one. Consequence: parity of old scheduling can be mistaken for proof of up-first scheduling. ADR-0052 itself says the engine has **no up-direction structural search** (`decisions.md:2922`). Replace “encoded” with “the client's orchestration must newly enforce.”

**Conclusion: broken.**

### N2 — `nit`: 0050 was reserved, not demonstrably renumbered

**Changed claim:** `decisions.md:3049` (“0050 was renumbered into ADR-0049's bound set”).

Precondition: a reader uses Status to reconcile the missing full ADR-0050 entry. Event order: inspect ADR-0049 Bound (`:2840`), ADR-0052 Status (`:2986`), and history introducing them (`git show 4b3c2a3 -- decisions.md`, `git show cf19299 -- decisions.md`). Failure point: that history introduces 0050 as a reserved digest and introduces 0051/0052 under their current numbers; it does not show the claimed renumber. Resulting state: incorrect numbering provenance despite a correctly selected 0053. Consequence: unnecessary ambiguity about whether 0050 is still reserved. Say “0050 remains reserved in ADR-0049's Bound section.” ADR-0052's older “0051 remains ... unwritten” is also stale now that its draft is present; label it historical if retained.

**Conclusion: broken.**

## Evidence limitations

- No source files were edited. No live model calls, OpenCode integration, or paid eval runs were attempted.
- An isolated index round-trip probe was attempted with temporary `WARDEN_CACHE_PATH` outside the repo, but could not run: installed `better-sqlite3` was built for Node ABI 127 while the active runtime requires ABI 137. No rebuild/reinstall was performed. D3 is established by the missing table handlers, copied backfill marker, and explicit deletion SQL; it is **not** reported as a successful live reproduction.
- The review does not prove OpenCode's hook semantics, SDK provider behavior, or hosted-store atomicity. Those remain explicitly unproven above rather than inferred from names or mocks.
