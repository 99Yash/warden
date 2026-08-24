# Structural review — the portable method (looking above and below the diff)

This is the **repo-agnostic** form of the structural-review method: the reusable
instrument, with every codebase-specific example lifted out into `{slots}`. It is
the text the ceiling pass (Lever D, ADR-0052) is distilled from, and it applies to
**any** repository Warden reviews — the method is language- and domain-neutral by
construction.

Two companion layers sit around it:

- **The floor** — the *surface sweep*: a bounded, closed catalog of known-defect
  rules matched against present code (Warden's det-prior corpus + reasoned
  behavioral workers). The prompts are known in advance, so the work is bounded,
  repeatable, and partly automatable. This doc does **not** re-list the floor.
- **A flavoring companion** (optional, per-repo) — fills the `{slots}` below with
  that repo's concrete idioms for a human contributor checklist. Do **not** bake
  those idioms back into this doc: a Warden-flavored registry example would teach
  the prompt Warden's stack, and the prompt reviews someone else's stack.

Read this when the diff may be correct line-by-line but either its *shape* (up) or
its *invariant* (down) might still be wrong.

> **Slot convention.** `{like this}` marks a place a concrete example would go in a
> repo-flavored edition. In the portable text the slot stays a *shape*, never a
> real symbol. Where an *example shape* is given, it is an abstract pattern
> ("a single-source-of-truth registry over N scattered lookups"), not a citation.

Every classifiable node in this method carries a **stable slug** (`axis.repetition`,
`dim.lifecycle`, `tier.1-static`, …). Those slugs are the join keys a *profile*
binds language- and repo-specific conventions to — concrete tells, substrate
primitives, enforcement mechanisms, poster-child registries, and known-good patterns
that must **not** be flagged. The method here is the portable base layer; profiles
cascade on top of it (base → language → repo, most-specific wins). See
[structural-review-profiles.md](./structural-review-profiles.md) for the class
registry, the profile schema, and worked examples. The base layer works standalone;
profiles are refinements applied *if needed*.

---

## Three review motions

Treat the changed lines as a surface. The method distinguishes three motions:

- **Surface is rule-guided verification.** Sweep changed code against the known
  floor rules. The prompts are known in advance, so the work is bounded and
  repeatable even though applying some rules still requires judgment; parts can be
  automated.
- **Up is structural search.** Infer a better domain shape that is *not present
  yet*, then measure the code against it. The target itself is unknown, so the
  work is generative and subjective. This is where *"these N scattered lookups
  should be one registry"* and *"this one guard is really two guards"* live.
- **Down is invariant proof.** Start from a behavior the change *claims*, then
  trace it through callers, state transitions, persistence, consumers, time, and
  failure until either the relevant paths preserve it or a counterexample breaks
  it. The target is known but the proof path is not. This is where *"the guard
  prevents the dangling reference but leaves the record stuck mid-lifecycle"* and
  *"the happy path is correct but a retry duplicates the side effect"* live.

These motions need different tools. Tool **verification** with a *list*. Tool
**up** with a *heuristic* — *what shape might be missing and how would we score
it?* Tool **down** with a *falsification strategy* — *what exact invariant is
claimed and what sequence would break it?* A list cannot generate the missing
abstraction, and line inspection cannot prove an end-to-end behavior. Handing an
open search a closed list is the central miss this doc exists to prevent.

**Fund up first; earn down selectively.** Run structural discovery *before* the
known-rule sweep so familiar local prompts do not anchor the whole review. Then
spend expensive down-depth on risky claims and candidate structures. Down is
selective because proving everything exhaustively is impossible — not because
untraced code is assumed correct.

The two open directions strengthen each other:

- **Up without down produces elegant incompleteness.** A new central shape can be
  conceptually right while mishandling legacy persisted data or a caller that
  relied on the old ambiguity.
- **Down without up produces serial patches.** A reviewer can close retries, stale
  state, and partial failure one at a time while missing that the same absent
  boundary or loose representation keeps recreating the class.
- **The loop is the method.** Discover upward, prove downward. When the proof finds
  several sibling failures, look upward again for the missing structure that would
  make the invariant inevitable, then trace that proposed structure downward once
  more.

---

## What a structural defect is

The essence is **drift between the code's structure and the domain's structure** —
the code splits what's really one thing, fuses what's really two, or claims a shape
it doesn't enforce.

That essence is hard to measure directly, so use its sharpest **revealer** (a
reliable tell, not the definition):

> A structural defect reveals itself when one domain change requires multiple
> coordinated edits and nothing makes that coordination inevitable.

Two things about this sentence do the work. "Multiple coordinated edits" is the
most *objective* symptom of drift — it converts taste into a cost you can name.
"Nothing makes that coordination inevitable" is a *gradient*, not a binary; see
[the enforcement ladder](#the-enforcement-ladder) for how strongly "inevitable" is
actually enforced.

The multi-edit test is the sharpest revealer, not the only one. Drift can bite
**before** it ever forces a second edit:

1. **Multiple coordinated edits** — the change touches N places and consistency
   isn't enforced. *(most objective)*
2. **Unsafe extension** — adding the next case is possible but unguided; the code
   lets you get it wrong (you *can* forget the default).
3. **Comprehension obstruction** — a reader can't recover the domain's shape from
   the code's shape; the map lies. *(most subjective, earliest to bite)*

A good restructure usually improves all three at once — one edit to extend, the
type forbids the illegal case, one place shows the whole catalog. The multi-edit
argument is just the most *legible* of the three benefits. Lead with whichever
revealer is most objective for the case at hand.

---

## Breadth discovers; depth proves

Discovery is breadth-first; depth is earned. The microscope **confirms** a
structural smell and **tries to break** a behavioral claim — it does not discover
missing structure by itself.

- **Pass 1 — orient.** Recover the change's intent, claimed invariants, affected
  domain facts, and trust boundaries. Without this, up has no domain to model and
  down has no claim to prove.
- **Pass 2 — wide, shallow, cheap (up-discovery).** Map where each fact,
  operation, and shape lives and *how many homes it has*. Collect candidate smells
  whose fix may not exist yet. Do **not** deep-read every function or dependency
  internal.
- **Pass 3 — bounded surface sweep.** Run the known floor rules across authored
  changed code, and reconcile generated artifacts against their sources. The
  prompts are comprehensive within the checklist's vocabulary; their application
  can still require judgment.
- **Pass 4 — deep, only where earned (down-proof).** Trace risky claimed
  invariants and candidate restructures through callers, state, dependencies, and
  failure modes. Try to *falsify* them with concrete sequences, and use evidence at
  the boundary where the claim actually lives.

Reading every function and every dependency file with a microscope spends the whole
budget on indiscriminate depth and none on wide perception. But stopping after the
wide pass is equally incomplete: it finds promising shapes without proving they
preserve behavior. Breadth chooses where depth will pay.

### Review sources, reconcile artifacts

Not every changed file deserves the same kind of attention. Classify the diff
before reviewing it:

- **Authored semantic sources** — application code, schemas, configuration,
  contracts, and hand-written migrations or scripts. These get the normal surface
  sweep, contribute to the up-map, and may earn down-depth.
- **Generated or derived artifacts** — lockfiles, generated SQL, snapshots,
  generated clients, build output, formatted metadata. Do **not** style-review or
  structurally redesign machine output. *Reconcile* the artifact against the
  authored source and the intended semantic delta: did the dependency resolve to
  the expected version, did schema generation emit only the intended operations,
  did the snapshot change for the stated reason?
- **External internals** — dependency source, generated framework internals,
  database implementation details, provider behavior. Not part of the routine
  review surface. Descend into them only when the invariant depends on behavior
  that public contracts, types, and focused probes do not establish.

This is *selective attention, not an ignore list.* A generated file becomes
evidence when its delta is surprising or high-consequence: a lockfile with an
unexpected source, a duplicate/incompatible resolution, or a version mismatch;
generated migration SQL with destructive or reordered operations, unsafe casts, or
a mismatch against the declared schema. The trigger is a concrete semantic
question; absent one, verify provenance and expected shape, then move on.

---

## Map the domain before judging the structure

The six axes below classify **how** code structure disagrees with domain
structure; they do not tell a reviewer **what domain structure to recover.** Start
the up-pass with an *obligation*: what must always remain true (safety), eventually
become true (liveness), or never occur? Then map only the dimensions that can make
or break it.

| Dimension | Slug | What to recover from the domain |
| --- | --- | --- |
| **Identity** | `dim.identity` | What persists through change? What counts as the same entity, attempt, message, value, or relationship? |
| **Authority** | `dim.authority` | Who may decide, mutate, validate, and enforce each rule, and over what scope? |
| **Lifecycle / state** | `dim.lifecycle` | What states, events, guards, terminal outcomes, and recovery transitions are legal? |
| **Consistency / coordination** | `dim.consistency` | Which observations or changes must agree? What atomicity, isolation, ordering, locking, or compensation holds them together? |
| **Time / order** | `dim.time` | Which claims depend on causality, freshness, deadlines, leases, expiry, scheduling, or wall-clock time? |
| **Effects / resources** | `dim.effects` | What is read, written, emitted, consumed, reserved, billed, retried, cancelled, acquired, released? Which effects are irreversible? |
| **Representation** | `dim.representation` | Which domain, wire, storage, and UI encodings exist? Which distinctions and invalid states do they preserve or erase, and where are values parsed or normalized? |
| **Source / derivation** | `dim.source` | Which state is canonical here, which is projected or cached, how stale may it be, and how is it rebuilt or reconciled? |
| **Substrate contract** | `dim.substrate` | Which guarantees and failure assumptions are delegated to the database, queue, runtime, browser, provider, clock, or operator? |

These are review *vocabulary*, not nine architecture components to instantiate. Do
not fill every row ritualistically. A pure formatter may need representation alone;
a retryable job with external effects may touch almost all nine. Record each
boundary with the claim it constrains instead of treating "boundary" as one thing:
semantic scope belongs with authority and source, a consistency boundary with
coordination, a trust boundary with representation, a deployment boundary with the
substrate contract. None is automatically a transaction, service, or bounded
context.

Evidence is not a tenth dimension; it is *how* the reviewer proves claims across
the nine. Observability can supply evidence about identity, state, causality, and
effects, but telemetry does not itself establish correctness. Recovery likewise
belongs in the lifecycle, effects, source/derivation, and substrate claims it
restores.

The primitives deliberately describe the *problem*, not the answer. Candidate
structures a reviewer might generate from a map — registries, discriminated result
envelopes, transaction-owned operations, monotonic cursors, boundary adapters,
capability objects — are *outputs* of the mapping, never primitives every domain
must contain.

### Run change probes

For each mapped claim, choose a nearby, credible domain change grounded in the
diff, the issue, the roadmap, or a repeated historical failure:

- add the next case, state, caller, consumer, or relationship;
- change one policy, ownership rule, ordering rule, or consistency boundary;
- introduce a second representation, context, account, or execution attempt;
- change the source of truth or a substrate guarantee the code currently leans on.

Then record:

| Obligation | Dimension | Domain claim | Current code mechanism / owner / representation | Grounded change | Coordinated edits | Enforcement |
| --- | --- | --- | --- | --- | --- | --- |

For every relevant claim, locate the corresponding code mechanism, owner, or
representation — or record that **none exists.** A mismatch in decomposition,
ownership, placement, dependency direction, representation, or substrate use is a
candidate up-finding; use the six axes to name its shape and the
[admission gates](#admission-gates) to decide whether changing it beats leaving it
alone. If the maps *align* but an execution fails to preserve the claim, that is a
**down-finding** instead. This table is the up-pass's work product *and* its
stopping rule: every affected obligation has an explicit code map; every structural
mismatch either clears the gates or is discarded.

The same map becomes the specification for drilling down. Up asks whether the
owners, boundaries, and representations match the domain; down asks whether those
claims survive actual execution.

---

## Six axes for looking up

These axes cover the recurring ways code structure drifts from domain structure.
They organize the search; they do not enumerate the improvements a reviewer may
discover. Treat them as lenses, not as proof that every structural defect fits a
closed taxonomy.

Each axis carries a **tell** (a cheap trigger you can spot in the wide pass), a
**pointer** (the generative question you run on a hit), and an **anti-pattern**
(the over-application that makes drift *worse*).

**1. Repetition** `axis.repetition` — *elements: too many copies of one.*
- Tell (greppable): the same literal / shape / try-catch appears 3+ times.
- Pointer: *how many places change together if this one fact changes?*
- Anti-pattern: DRYing *coincidental* duplication — things that look alike but
  change independently.
- Example shape: `{N scattered lookups of one fact → a single-source registry}`.

**2. Conflation** `axis.conflation` — *elements: one construct doing several jobs.*
- Tell: the true description contains "and"/"or"; a boolean parameter that switches
  behavior; a vague name (`handle`, `process`, `data`) broad enough to hide two
  concepts.
- Pointer: *is this one concept or two? does the name make a single promise?*
- Anti-pattern: over-decomposition — splitting things that really are one, paying an
  indirection tax.
- Example shape: `{one predicate answering two questions that a given input answers
  oppositely → two named guards}`.

**3. Misplacement** `axis.misplacement` — *boundaries: seams not cut at the domain's joints.*
- Tell: a module imports another module's non-public internals; a `utils` folder
  accreting unrelated things; a helper living far from its only caller.
- Pointer: *is this cut where the domain actually joints? does this belong to the
  thing it lives in?*
- Anti-pattern: moving code to a tidier taxonomy that's farther from use —
  colocation usually beats classification.

**4. Wrong dependency direction** `axis.wrong-direction` — *dependencies: stable follows volatile.*
- Tell (partly automatable): an import cycle; a stable/shared module importing an
  app-specific one.
- Pointer: *does the more-stable thing depend on the more-volatile, or the
  reverse?*
- Anti-pattern: a one-implementer interface added "for flexibility" — speculative
  generality.

**5. Loose representation** `axis.loose-representation` — *encodings: illegal states allowed.*
- Tell (greppable): nullable fields littered with non-null assertions; several
  booleans never independently true (a disguised enum); a type cast — the cast is
  the code *confessing* its type is looser than reality.
- Pointer: *does this encoding permit a state the domain forbids? can I tighten it
  until wrong won't compile?*
- Anti-pattern: freezing today's accident into tomorrow's constraint by
  over-tightening.
- Example shape: `{a type-level constraint that makes a registered-but-incomplete
  entry unrepresentable}`.

**6. Reinvention** `axis.reinvention` — *substrate: rebuilding what's provided.*
- Tell (greppable): a hand-rolled thing with a substrate primitive one import away
  — manual JSON try/catch where a validator exists; a hand-written insert type
  where the schema can infer one.
- Pointer: *what does the library/runtime already give me that this rebuilds?*
- Anti-pattern: coupling to a substrate detail that's actually more volatile than
  your own code.

High-value moves often improve several axes at once (a registry is typically
**1 + 5 + 6**; a guard split is **2 + 5**). That convergence *strengthens* a
proposal, but it is supporting evidence, not a scoring system — **one clearly
demonstrated axis is enough.**

### Where judgment actually goes

Some **tells** are cheap enough to collect during the bounded surface sweep:

- **Repetition** and **loose representation** — candidate sites are often greppable
  (casts, non-null assertions, duplicated literals or shapes).
- **Wrong direction** — cycle detection and boundary lint.

But a tell is **not a finding.** Deciding whether duplication shares one truth,
whether a type is looser than the domain, or whether library behavior really
subsumes local code still requires judgment. **Conflation** (*one concept or two?*)
and **misplacement** (*cut at the joint?*) have especially weak mechanical tells,
so protect time for them — but do not pretend the other axes can be *concluded* by
grep. A repetition tell only becomes a registry after the global claim that all the
sites form one catalog; a conflation finding only exists after perceiving two
concepts behind one name.

---

## Three dimensions for drilling down

Down starts from a *claim*, not a file. Write the intended invariant before tracing
it:

> Given **preconditions**, after any allowed sequence of **events and failures**,
> **property** remains true; if it cannot, **recovery** restores it without
> **forbidden effects**.

"The update succeeds" is not an invariant. "A retried webhook creates at most one
domain write and acknowledges only after that write is durable" is. The sharper
sentence tells the reviewer which counterexamples matter and when the proof is
complete.

Trace the claim in three dimensions:

- **Through the system — follow the value and effect.** Start at every entry point,
  cross validation and authorization, follow state transitions and writes, then
  inspect every consumer and externally visible side effect. Ask where ownership
  changes and where an error can be translated, swallowed, or separated from the
  state it describes.
- **Through time — follow the sequence.** Inspect before, during, after, retry,
  duplicate delivery, cancellation, concurrent execution, stale queued work, and
  recovery/backfill. Most deep defects are legal lines in an illegal order.
- **Down to authority — follow the claim to the layer that decides it.** A wrapper
  name, comment, mock, or type is not proof of database, queue, browser, or
  provider behavior. Read the substrate contract or run the smallest
  integration/live probe when the invariant depends on its semantics.

These are search dimensions, not a demand to enumerate the universe. Derive
concrete counterexamples from the invariant's *own* state machine. Stale state
matters only where state can age; idempotency matters only where work can repeat;
partial failure matters where one logical action crosses atomicity boundaries.
Generic failure lists are prompts for finding those joints, not proof that the
invariant was audited.

### What earns depth

Deep tracing is expensive, so spend it where consequence or uncertainty is high:

- a multi-step write, queue/job, external side effect, cache, retry, migration, or
  repair path;
- a changed contract, guard, authorization boundary, source of truth, or persisted
  representation;
- a structural proposal that moves ownership or claims to make a class of failure
  impossible;
- a bug fix whose first patch closes one symptom but leaves sibling sequences
  plausible.

For each selected claim, try to produce a concrete *breaking sequence* before
trying to confirm it. Then use evidence matched to the claim: types or constraints
for static impossibility, focused tests for local transitions, integration tests
for persistence and concurrency, dependency source or live probes for external
semantics. A green unit test is not evidence for behavior its mock chose not to
model.

Down ends with one of three conclusions: **closed within scope** (the explicitly
named paths and assumptions preserve the invariant, with evidence), **broken** (a
concrete counterexample exists), or **unproven** (name the missing evidence and the
residual risk). *"Looks correct" is not a conclusion.*

---

## The enforcement ladder

"Nothing makes that coordination inevitable" is a gradient. When a restructure
claims to hold N edits together, name **how**, because the mechanism decides
whether the gap is actually closed:

| Tier | Slug | Mechanism | Effect |
| --- | --- | --- | --- |
| 1 | `tier.1-static` | **Static enforcement** | Construction, types, lint, or boundary checks reject the wrong structure before runtime. |
| 2 | `tier.2-runtime` | **Runtime validation** | The wrong value can't enter or persist. |
| 3 | `tier.3-ownership` | **Centralized ownership** | One place owns the fact or operation — a source of truth. |
| 4 | `tier.4-tests` | Tests | Divergence is *detected*, after it happens. |
| 5 | `tier.5-convention` | Convention / documentation | Humans are *asked* not to diverge. |

**Only tiers 1–3 substantially close the structural gap.** Tests detect drift after
the fact; convention merely requests that humans not introduce it. But the tiers
are not interchangeable: static types cannot validate untrusted runtime data, and
centralized ownership does not prevent bypass unless a boundary check also closes
the other doors. Choose the *earliest* mechanism that can enforce the specific
invariant, and *compose* mechanisms when the invariant crosses static, runtime, and
ownership boundaries.

Example shapes per tier:

- **Tier 1** — a type-level constraint that won't build if an entry is incomplete; a
  derived type that can't drift from its source; an exhaustive-switch `never` guard;
  a boundary check that rejects a forbidden import.
- **Tier 2** — a validator that refuses an invalid value at a trust boundary.
- **Tier 3** — a registry as the one catalog; a single accessor as the intended
  door to a shared resource; a single matcher as the sole home of a rule.
- **Tier 4** — a test that catches a regression but doesn't *prevent* someone from
  re-introducing it.
- **Tier 5** — "always go through this module" enforced by nothing but that
  sentence; it stays tier 5 until a check covers it. The characteristic upgrade this
  whole ladder asks for is promoting a tier-5 convention to a tier-1 boundary check.

A type cast asks the compiler to trust a claim it did not prove. That makes it a
useful axis-5 tell — though not automatically a defect: the review still has to
find the owning boundary and decide whether validation or a derived type can
replace the claim.

---

## Admission gates

Subjective doesn't mean unrigorous. An **up-proposal** earns its place only if it
clears three gates:

- **A. Name the change it de-risks.** *"This should be a registry"* is taste.
  *"Adding the next entry touches N files and can silently forget a required part;
  a registry makes it one file and the type forbids forgetting"* is an argument. No
  named change → **rejected as aesthetics.**
- **B. Clear the axis's anti-pattern.** State that the things genuinely share a
  *truth or invariant*, not merely syntax — name the domain changes under which they
  co-vary, or show that the seam is the domain's real joint. This is the guardrail
  that stops "find the hidden registry" from manufacturing speculative
  architecture.
- **C. Name the enforcement mechanism and its remaining gap.** A registry held
  together by "please import from here" (tier 5) is weaker than one whose entries
  are statically checked (tier 1) — but runtime input may still need validation
  (tier 2). Use the strongest applicable *combination* rather than assuming one tier
  replaces the others.

A **down-finding** has a parallel burden:

- **A. State the invariant, not the symptom.** "This record can stay mid-lifecycle"
  matters because it violates a *named* lifecycle or recovery guarantee.
- **B. Give the counterexample as a sequence.** Name the precondition, event order,
  failure point, resulting state, and user-visible or operational consequence.
- **C. Prove the substrate assumptions.** Distinguish what the code establishes from
  what a transaction, queue, provider, or browser is merely *assumed* to do.
- **D. Test the whole proposed closure.** A fix that prevents a dangling reference by
  silently stranding the parent state has *moved* the failure, not closed the
  invariant.

---

## Exemplars — structure so aligned the coordination is inevitable

The rest of this doc teaches drift *detection*: you find missing structure by
measuring code against a better shape you infer. But the up-pass can only aim at a
shape you have already internalized — you cannot recognize what's missing without a
felt sense of *present-and-right*. This section reads one widely-admired codebase
and extracts its transferable moves as the *positive* form of the six axes: not
"where does structure drift" but "what does it look like when it doesn't." It is
deliberately third-party (not this repo, not the reviewed repo), so it stays a
neutral north star.

The codebase is Andre Weissflog's [`floooh/chips`](https://github.com/floooh/chips)
— dependency-free 8-bit chip and computer emulators, each a single C header,
praised as *"poetry-code."* The language is C and the domain is silicon; every move
below is language- and domain-agnostic. Each names the axes it nails, the
enforcement tier that makes it hold, and the up-question a reviewer of *any* repo
can ask by analogy.

**1. One protocol, many implementations** — *cut the interface at the domain's real
bus.*
- What it is: every chip — from a ~120-line beeper to the ~138 KB Z80 — exposes the
  identical shape: `<chip>_init`, `<chip>_reset`, `<chip>_tick(state, pins) → pins`,
  where `pins` is a single integer carrying the entire bus. A whole computer is then
  "just wiring": the system tick threads one chip's output pins into the next's
  input, exactly as they'd be soldered.
- Why it holds: axes **3 + 1**. The seam is cut at the domain's own joint — the
  physical bus — so there is no per-chip glue to keep consistent. Enforcement
  **tier 1**: the shared signature *is* the contract; a component that doesn't fit
  can't be wired in.
- Ask of the repo under review: does each integration/handler meet **one** dispatch
  contract — `(input) → result` — or does the next one need its own bespoke calling
  convention? A new convention is the tell the seam isn't at the joint.

**2. State is a value; save, load, and replay fall out for free** — *represent the
whole machine so nothing can escape serialization.*
- What it is: the entire emulator state is a plain struct with no owned heap graph.
  A snapshot is a struct copy plus a few hooks that re-patch the handful of live
  pointers, guarded by a single version integer that refuses a mismatched layout on
  load.
- Why it holds: axes **5 + source/derivation**. The representation admits no
  un-snapshottable state, so "forgot to serialize field X" is *unrepresentable*
  rather than a bug you test for. Enforcement **tier 1** (plain-value-ness) composed
  with **tier 2** (the version guard rejects an incompatible load).
- Ask of the repo under review: flag any state that can only be reconstructed by
  re-running side effects, and any projection that cannot be replayed from its
  source. A single version integer is the migration-version discipline.

**3. Generate the co-varying bulk from a spec that reads like the domain** — *when N
cases move together, make the table the artifact and the code its projection.*
- What it is: the ~1,700-step instruction decoder — the most error-prone code in the
  project — is **generated** from a declarative spec written in the domain's own
  vocabulary, injected back between markers in the same header so it regenerates
  idempotently and can't be hand-edited into drift.
- Why it holds: axes **1 + 6**. Hundreds of near-identical branches collapse to one
  declarative table, and the decode structure the hardware already defines is reused
  rather than re-derived. Enforcement **tier 1/3**: the spec is the single source of
  truth and the generator owns the region.
- Ask of the repo under review: for any table-shaped domain, does *one* table
  generate the code, or does the table live implicitly and fragilely across N
  hand-written branches?

**4. Stable primitives are ignorant of their compositions** — *volatile depends on
stable, never the reverse.*
- What it is: a chip header knows nothing about any computer that uses it; the system
  header composes chips; shared substrate helpers sit at the bottom, depended on by
  both and depending on neither. Dependencies point one way: system → chip →
  substrate.
- Why it holds: axis **4** in its positive form. Enforcement **tier 1** wherever a
  boundary check exists.
- Ask of the repo under review: which are the stable primitives, and does any of
  them import an app-specific module? That's the reviewable violation — and a
  candidate for promoting the rule from convention (tier 5) to lint (tier 1).

**5. The source carries its own schematic — and names its shortcuts** — *don't make
the reviewer reverse-engineer the map you already hold.*
- What it is: headers open with an ASCII diagram and a progressive HOWTO; the README
  states up front where the emulation is *deliberately* impure and lists each known,
  tolerated failure with *why* it's acceptable; a large refactor is logged as "no
  behaviour changes."
- Why it holds: the antidote to the earliest-biting revealer — *comprehension
  obstruction.* The map doesn't lie because the author drew it, and the honest
  shortcut list tells the reviewer which boundaries are real and which are pragmatic.
  Enforcement **tier 5** (convention), but load-bearing: the up-pass's most expensive
  work is recovering the domain map, so a codebase that front-loads it is one a
  reviewer can actually look *up* from.
- Ask of the repo under review: does an ADR or header comment state the invariant,
  the deliberate shortcut, *and* the residual risk? A documented "known failure, OK
  because …" is literally a down-conclusion of *unproven — here is the accepted
  residual risk*, recorded in advance.

> The through-line: in every case the code's structure is a faithful image of the
> domain's structure — a chip is a struct, a bus is an integer, a computer is a
> wiring function, the opcode table is a table. When the map is that faithful, one
> domain change lands in one place *because there is nowhere else it could go.* That
> is the north star the up-pass triangulates toward.

---

## The forcing function

A review that returns only local nits has performed only the surface sweep. Before
finishing:

- Produce **at least one up-observation** by running the pointers for the axes the
  diff touches, *or* state explicitly that you looked and none applies, and why.
- For every claim that earned depth, give a **down-conclusion**: closed within
  scope, broken, or unproven, with the invariant and evidence. If no claim earned
  depth, state *why* the change is low-risk enough not to trace.

Silence is not evidence of clean structure or closed behavior; it is usually
evidence that the corresponding direction never ran.

> **Precision guard (for automated use).** The forcing function is a *recall*
> device that carries a real *precision* risk: a hard quota manufactures
> architecture. So it must be paired with the admission gates — produce an
> observation *or* an explicit "none applies," but a candidate becomes a *posted*
> finding only by clearing gates A/B/C. The "none applies" branch posts nothing;
> the anti-pattern gate discards the rest. Recall device, precision-gated.

---

## Summary pass

1. **Orient:** state the change's intent and obligations; classify changed files as
   authored sources, derived artifacts, or external internals.
2. **Map the domain:** recover the relevant identities, authorities, lifecycle,
   coordination, time, effects, representations, sources, and substrate
   assumptions; qualify each boundary at the dimension it constrains.
3. **Probe and look up:** run grounded domain changes, compare each claim with its
   code mechanism/owner/representation, then classify structural mismatches with the
   six axes; route execution counterexamples down.
4. **Sweep the surface:** apply the bounded floor prompts to authored semantic
   sources; reconcile generated artifacts against their source and intended delta.
5. **Gate up-candidates:** name the exposing change, the shared truth, the
   anti-pattern risk, the enforcement mechanism, and the remaining gap; hold the
   proposed shape to the [exemplar](#exemplars--structure-so-aligned-the-coordination-is-inevitable)
   standard — would one domain change land in one place because there is nowhere
   else it could go?
6. **Choose depth:** select risky invariants and restructures that move ownership or
   behavior.
7. **Drill down:** follow each claim through the system, through time, and to the
   authoritative substrate; actively seek a breaking sequence.
8. **Loop:** if several down-findings share a cause, look up for the missing
   mechanism; if an up-proposal emerges, prove it down again.
9. **Report:** give the required up-observation and each selected claim's
   closed-within-scope / broken / unproven conclusion.

---

## Provenance & sources

Adapted to portable form from the sibling `alfred` repo's
`docs/reference/structural-review.md` (+ its floor companion `code-style.md`), the
docs that motivated **ADR-0052 (Lever D)**. The floor/ceiling framing, the six
axes, the enforcement ladder, and the admission gates are that method lifted out of
one stack's examples into `{slots}` so the same instrument can review any repo.

The vocabulary is grounded in the
[DDD reference](https://www.domainlanguage.com/ddd/reference/) for identity,
authority, aggregates, and bounded contexts;
[Parnas's decomposition criterion](https://dl.acm.org/doi/10.1145/361598.361623)
for change-oriented boundaries;
[Parse, Don't Validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/)
for representation at trust boundaries;
[safety and liveness](https://www.cs.cornell.edu/fbs/publications/DefLiveness.pdf),
[Lamport's causal ordering](https://lamport.azurewebsites.net/pubs/time-clocks.pdf),
and [transaction limits](https://www.vldb.org/conf/1981/P144.PDF) for down-proof;
and [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods)
for precise retry semantics. These are sources for *questions*, not architectures to
impose. A worked positive exemplar is Andre Weissflog's
[`floooh/chips`](https://github.com/floooh/chips), read in the
[Exemplars](#exemplars--structure-so-aligned-the-coordination-is-inevitable)
section above.
