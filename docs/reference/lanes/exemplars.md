# Up-lane exemplars — the positive form of the six axes

Lane material for the **up** lane. The up charter
(`docs/reference/lanes/up.md`) includes the section below; the down lane
does not load it. The section moved here from
`docs/reference/structural-review.md` on 2026-10-20, so that each lane
loads only the sections its charter selects. The method doc keeps a
pointer to this file.

## Exemplars — structure so aligned the coordination is inevitable

The structural-review method teaches drift *detection*: you find missing structure by
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
