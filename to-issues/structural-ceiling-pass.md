# Ratify Lever D: structural / "ceiling" review pass

**Severity:** high (recall + precision). **Needs ADR ratification before code.**

## Problem

Warden's current review engine searches primarily for known defect shapes: its
detectors and reasoned workers verify code against a behavioral-review floor.
It does not run the complementary, open-ended search for structural drift
between the code's shape and the domain's shape.

ADR-0052 proposes Lever D, a dedicated structural / ceiling pass. The proposal
is intentionally not owner-ratified yet. Its precision controls, relationship
to Lever C, and evaluation contract need to survive a grill before any
implementation work is split or assigned.

## What to decide

- Stress-test the six structural axes and the two-pass discovery/confirmation
  shape against concrete Warden and alfred examples.
- Decide whether Lever C (#31) is a hard prerequisite or should co-ship with
  the first structural tracer bullet.
- Validate the three admissibility gates and the enforcement-ladder mapping
  that demotes tier 4-5 proposals to questions or suppresses them.
- Lock the evaluation contract: real-worktree recall fixtures, one false-
  positive trap per axis, existing PR#131 precision traps, ladder fidelity,
  and the existing cost ceiling.
- Decide whether the Warden-flavored floor/ceiling reference-doc pair lands
  before implementation or with the first implementation slice.

## Acceptance criteria

- [x] ADR-0052 receives a focused grill covering precision, cost, fixture
      reachability, and the Lever C dependency. — **done 2026-07-20**
      (`/grill-with-docs`); outcomes below.
- [~] Each anti-pattern false-positive trap has a concrete, testable fixture
      candidate. — **scoped to the 4 v0 axes** (repetition, loose-representation,
      reinvention, wrong-direction); conflation + misplacement traps deferred with
      those axes to v1.
- [x] The ladder-fidelity precondition has an unambiguous expected outcome for
      tier-5 candidates. — **`enforcementTier >= 4 ⇒ kind: question`, asserted
      directly on the new `enforcementTier` field** (outcome 5).
- [x] The reference-doc delivery timing is decided. — **landed now**, ahead of
      implementation: `docs/reference/structural-review.md` (portable method) +
      `docs/reference/structural-review-profiles.md` (classification/profiles).
      C-independent, so no reason to hold them.
- [ ] ADR-0052 is explicitly adopted, revised, or rejected; implementation
      issues are drafted only from the ratified result. — **deferred by owner
      decision:** ADR-0052 stays `proposed`; the outcomes below are staged here,
      not folded into `decisions.md`, until ADR-0051 (C) and ADR-0050 are grilled
      (they may reshape D). Revisit ratification then.

## Grill outcomes — 2026-07-20 (`/grill-with-docs`)

Grounded against source during the grill: lane discipline is real
(`review-harness/tools/dispatch-worker.ts:320-401`, `commentInLane`); `det-priors.ts`
already runs `jscpd` (`:28`, `:436-485`); `finding-schema.ts` has `kind`
(`assertion|question`, `:41`) + `confidence` (`:48`) but its `tier` field is
**severity `1|2|3`** (`:40`), *not* the enforcement ladder — so §4's "reuse `tier`"
is wrong. Recall is machine-scored by **path + line within a drift window**
(`run.mts:478`, `:562-565`), not by prose tags. **ADR-0051 (Lever C) and ADR-0050
do not exist yet** — only reserved/named in ADR-0049; `lane-discipline-cross-file-evidence.md`
is a 41-line stub.

1. **Sequencing — C first (hard dependency honored).** Do *not* decouple via an
   in-lane-only tracer. Write + grill **ADR-0051 (Lever C)** and **ADR-0050**, land
   C's substring-verified out-of-lane sourcing relaxation, *then* build D on top. D
   is gated behind ~2 ADRs of work by choice, for full fidelity to the structural
   vision (drift between new code and *existing* code is the high-value case, and it
   is out-of-lane by construction).

2. **v0 axis scope — the 4 greppable-tell axes only.** Ship `axis.repetition`,
   `axis.loose-representation`, `axis.reinvention`, `axis.wrong-direction` (all have
   deterministic Pass-1 seeds, `jscpd` already present). **Defer `axis.conflation`
   + `axis.misplacement` to v1** — weak mechanical tells, need an uncached
   cheap-model breadth scan, and carry the highest "manufactures architecture" FP
   risk. Concentrate the v0 precision budget where tells are real.

3. **Profile layer — full cascade + discovery in v0**, including `lang:go` /
   `lang:python`. v0 can review arbitrary repos out of the gate. Consequence
   accepted: discovery error is a new precision vector (outcome 4 contains it). Note
   two of the four v0 axes now depend on profile data — `reinvention` needs
   `primitives`, `wrong-direction` needs `boundaries`.

4. **Discovery bias — evidence-only, conservative floor.** A tier is
   `available: true` *only* on positive evidence (strict `tsconfig`, a validator
   dep, a boundary-lint script); undetected ⇒ `false`. A real finding whose only
   confirmable enforcement is then tier 4-5 posts **as a question** via ladder→kind
   (ADR-0044) — never a false assertion, never silently dropped. All discovery error
   biases toward recall-softening, away from precision-poisoning.

5. **Enforcement-ladder representation — add `enforcementTier: 1..5`.** A small,
   explicit field on the structural (reasoned) finding, *separate* from the severity
   `tier: 1|2|3`. Rule: **`enforcementTier >= 4 ⇒ kind: question`.** Makes
   ladder→kind auditable and the ladder-fidelity eval leg checkable on a typed field
   rather than parsed prose. Corrects §4's "reuse `tier`, add nothing" — it reuses
   `confidence`/`kind` but needs this one new field.

6. **Anti-pattern precision control — layered, not pure-exclusions** (corrects the
   2026-07-20 classification amendment's over-claim): **(layer 1, primary)** gate B
   is a per-finding prompt *judgment* — prove the sites share a truth/invariant or
   discard as syntax; general, works on any repo. **(layer 2, hardening)** profile
   `exclusions` catch *specific recurring* known-good instances (Go `if err != nil`,
   a validated-boundary `as`); accumulate from dogfood FPs. **(layer 3, verify)**
   eval FP-trap fixtures, one `expect: absent` per shipped v0 axis (4). Anti-patterns
   are judgments, not enumerable data, so exclusions can only *harden*, never *be*
   the control.

7. **Recall scoring — add a dedicated `structural` `CategoryEnum` slot** (reverses
   ADR-0052 alternative (7)). Path+line matching alone can't distinguish a structural
   catch from a coincidental behavioral finding at the same anchor; with structural
   findings routed into `clarity`/`dedup` the scorer has nothing to filter on. So:
   `caught ⇔ path+line match AND comment.category === "structural"`. The `axis` slug
   still rides as a sub-tag (for `exclusions`, `enforcementTier` reasoning, per-axis
   FP-trap scoring); `category: structural` is the recall discriminator. The
   eval-scoring need *is* the "unless eval volume demands it" trigger the ADR
   reserved.

## Open for the next grills (ADR-0051 / ADR-0050)

- ADR-0051 (Lever C): the exact out-of-lane sourcing relaxation D depends on — one
  in-lane anchor + substring-verified out-of-lane corroborating `sources[]`. D's
  multi-home evidence is the forcing case; design C *for* it.
- ADR-0050: the init-time repo-intent digest — how much of profile **discovery**
  (outcome 3) overlaps ADR-0050's "senior-engineer cursory pass"; they may share the
  cross-file/inference machinery (ADR-0018's deferred AST-verified symbol-ref signal).
- Then revisit ADR-0052 ratification with outcomes 1-7 folded in, plus the `structural`
  `CategoryEnum` ripple (routing, config, `CONTEXT.md` glossary: **structural defect**,
  **floor/ceiling pass**, **six axes**, **enforcement ladder** + `enforcementTier`,
  **admissibility gates**, **structural-review profile / cascade / class slug / tier
  availability**).

## Blocked by

**ADR-0051 (Lever C) and ADR-0050 — both unwritten and ungrilled** (grill outcome 1).
Lever D implementation is blocked until C's lane-discipline relaxation is designed,
grilled, and landed. The reference docs (method + profiles) are *not* blocked and are
already landed.

- [Lever C](https://github.com/99Yash/warden/issues/31) — the hard prerequisite.

## Refs

- ADR-0052 in `decisions.md`
- ADR-0044 (reasoned findings and confidence-sets-kind)
- ADR-0047 (proof-bearing evidence and false-positive traps)
- `docs/reference/code-style.md` and `docs/reference/structural-review.md` in
  the sibling alfred repository

