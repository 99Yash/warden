# Structural-review profiles — classification & the repo/language override layer

[structural-review.md](./structural-review.md) is the **portable method**: every
node in it (a motion, an axis, a domain dimension, a ladder tier, a gate) carries a
**stable slug**. This doc is the layer that hangs concrete conventions off those
slugs so the same method can run against a TypeScript monorepo, a Go service, or a
Python library without rewriting the method — and so Warden can dogfood the exact
methodology it applies to other repos.

The split is deliberate:

- **The method is a search *shape*** — language- and domain-neutral. It never
  names a real symbol.
- **A profile is the *bindings*** — the greppable tells, substrate primitives,
  enforcement mechanisms, canonical registries, and known-good patterns that make
  the shape actionable in one stack.

This is how ADR-0052 §7 resolves without contradiction: the Warden-flavored
grounding the ADR wanted lives in **Warden's repo profile**, not baked into the
method text — because the Lever D prompt reviews *arbitrary* target repos, and each
target contributes *its own* discovered profile.

---

## The cascade

Profiles compose most-specific-wins, like CSS or `tsconfig` `extends`:

```
base            the method itself — slugs only, no bindings
  └─ lang:*     conventions true for a language/ecosystem (lang:typescript, lang:go)
       └─ repo:*  conventions true for one repository (repo:warden, or a discovered
                  target-repo profile)
```

At review time Lever D resolves a chain — `base → lang:<detected> → repo:<this
repo>` — into one **effective profile**. For a repo Warden reviews that ships no
profile of its own, the repo layer is *discovered* (§ Discovery below); an explicit
`.warden/profile.*` in the target overrides the discovery.

### Merge semantics

| Field kind | Rule |
| --- | --- |
| **List-valued** (`tells`, `primitives`, `exemplars`, `exclusions`, `mechanisms`, `boundaries`, `sourcesOfTruth`) | **Union**, deduped by identity. A more-specific layer *adds*; it does not shadow. |
| **Scalar** (`available`, per-node `notes`) | **Override** — most-specific layer wins. |
| **`exclusions`** (known-good; do-not-flag) | Union, and **sticky**: a suppression from any layer holds. To re-enable a suppressed pattern, a layer sets `unexclude` explicitly (rare escape hatch). |

Rationale: tells and primitives should *accumulate* (a repo knows more than its
language), but whether a tier is even *reachable* is a hard scalar the most-specific
layer must be able to assert (a plain-JS repo has no `tier.1-static`, period).

---

## The class registry (the join keys)

Every slug a profile may bind to. Grouped by classification. The method doc is the
authority on *meaning*; this table is the authority on *identity*.

### Motions & passes (structural — profiles rarely bind here)

| Slug | Node |
| --- | --- |
| `motion.surface` / `motion.up` / `motion.down` | The three review motions |
| `pass.1-orient` / `pass.2-up-discovery` / `pass.3-surface-sweep` / `pass.4-down-proof` | The four passes |
| `file.authored` / `file.generated` / `file.external` | The three file classes (drives *review vs reconcile vs descend*) |

### Domain dimensions (`dim.*`) — bind substrate & boundaries

`dim.identity` · `dim.authority` · `dim.lifecycle` · `dim.consistency` ·
`dim.time` · `dim.effects` · `dim.representation` · `dim.source` · `dim.substrate`

### Up-axes (`axis.*`) — bind tells, primitives, exclusions, exemplars

`axis.repetition` · `axis.conflation` · `axis.misplacement` ·
`axis.wrong-direction` · `axis.loose-representation` · `axis.reinvention`

### Down-dimensions (`down.*`) — structural

`down.system` · `down.time` · `down.authority`

### Enforcement tiers (`tier.*`) — bind availability & mechanisms

`tier.1-static` · `tier.2-runtime` · `tier.3-ownership` · `tier.4-tests` ·
`tier.5-convention`

### Admission gates (`gate.*`) — structural (profiles may add repo notes)

`gate.up.a-derisks` · `gate.up.b-anti-pattern` · `gate.up.c-enforcement` ·
`gate.down.a-invariant` · `gate.down.b-sequence` · `gate.down.c-substrate` ·
`gate.down.d-closure`

---

## The profile schema

A profile is data, not prose — so Lever D can load and merge profiles
deterministically. This is the *spec* (no code ships until ADR-0052 clears its eval
gate); the shape:

```ts
type Slug = string; // must be a member of the class registry above

interface StructuralProfile {
  id: string;                 // "base" | "lang:typescript" | "repo:warden" | "repo:<name>"
  extends?: string[];         // parent ids, resolved left→right, this wins last
  axes?: Partial<Record<Slug, AxisBinding>>;
  tiers?: Partial<Record<Slug, TierBinding>>;
  dims?: Partial<Record<Slug, DimBinding>>;
  sourcesOfTruth?: Ref[];     // canonical registries / derived shapes (feeds axis.repetition + tier.3-ownership)
  boundaries?: Boundary[];    // dependency-direction rules (feeds axis.wrong-direction + dim.substrate)
}

interface AxisBinding {
  tells?: Tell[];             // Pass-1 detectors for THIS axis in THIS stack
  primitives?: Primitive[];   // mainly axis.reinvention: substrate that already exists
  exclusions?: Pattern[];     // matches a tell but is known-good here → never flag (grounded FP trap)
  exemplars?: Ref[];          // positive poster children — the felt-sense-of-right anchors
  notes?: string;
}

interface Tell {
  kind: "regex" | "ast" | "tool";
  query: string;              // regex source | AST query | "tool arg…"
  description: string;
  // A tell is NEVER a finding on its own — it only seeds Pass-2 judgment.
}

interface Primitive {          // "don't hand-roll X; Y already provides it"
  rebuilds: string;           // the thing hand-rolling would reproduce
  use: string;                // the substrate primitive one import away
}

interface TierBinding {
  available: boolean;         // is this enforcement tier reachable in this stack AT ALL?
  mechanisms?: string[];      // concrete enforcers ("tsc", "oxlint boundary check", "never-switch")
}

interface DimBinding {
  substrate?: string[];       // delegated guarantees (db/queue/runtime/provider) — feeds down.authority proofs
  notes?: string;
}

interface Boundary {
  stable: string;             // glob for the stable/shared module
  forbid: string[];           // globs it must NOT depend on
  enforcedBy?: string;        // tier slug + mechanism; absent ⇒ tier.5-convention (upgrade candidate)
}

type Ref = { path: string; symbol?: string; note?: string };
type Pattern = { query: string; reason: string };
```

### Why `tier.available` is load-bearing

The method says "take the *strongest applicable* enforcement tier." *Applicable* is
**language-relative**. A `tier.1-static` proposal ("make the illegal state
unrepresentable in the type") is nonsense in a language with no static types. The
profile's `tiers[tier.1-static].available = false` tells Lever D to **downgrade**
the strongest reachable tier for that stack — which flows through
ladder→confidence→kind (ADR-0044) and correctly demotes an unreachable-enforcement
proposal to a question instead of a false assertion. Without this, Lever D would
propose fixes the target stack can't hold.

---

## Worked example — `lang:typescript`

```jsonc
{
  "id": "lang:typescript",
  "extends": ["base"],
  "axes": {
    "axis.loose-representation": {
      "tells": [
        { "kind": "regex", "query": "\\bas\\s+(?!const\\b)[A-Z]", "description": "type assertion — the code confessing its type is looser than reality" },
        { "kind": "regex", "query": "[\\w\\])]\\!(?=[.\\[;,)\\s])", "description": "non-null assertion — a runtime promise the compiler can't keep" },
        { "kind": "ast", "query": "object with 3+ boolean fields never independently true", "description": "a disguised enum" }
      ]
    },
    "axis.reinvention": {
      "primitives": [
        { "rebuilds": "manual JSON.parse + try/catch validation", "use": "a schema validator (zod/valibot) at the boundary" },
        { "rebuilds": "a hand-written insert/row type mirroring a table", "use": "the ORM's inferred type ($inferInsert / $inferSelect / z.infer)" }
      ]
    },
    "axis.wrong-direction": {
      "tells": [
        { "kind": "tool", "query": "madge --circular src", "description": "import cycle" },
        { "kind": "tool", "query": "dependency-cruiser boundary rules", "description": "stable module importing app-specific one" }
      ]
    },
    "axis.repetition": {
      "tells": [
        { "kind": "tool", "query": "jscpd", "description": "copy-paste blocks (tell only — confirm one shared truth in Pass 2)" }
      ]
    }
  },
  "tiers": {
    "tier.1-static": { "available": true, "mechanisms": ["tsc --strict", "exhaustive never-switch", "satisfies", "boundary lint"] },
    "tier.2-runtime": { "available": true, "mechanisms": ["zod/valibot parse at trust boundary"] },
    "tier.3-ownership": { "available": true },
    "tier.4-tests": { "available": true },
    "tier.5-convention": { "available": true }
  }
}
```

### Sibling — `lang:go`

Go moves the tells elsewhere: there is no `as`/`!`, but `interface{}` +
type-assertion `.(T)`, silent zero values, and ignored errors are the
loose-representation surface, and cycle/boundary control is first-class. Note
`tier.2-runtime` is **not universally available** — Go has no built-in schema
validator, so it's marked available only when the repo actually pulls one in
(discovery flips this).

```jsonc
{
  "id": "lang:go",
  "extends": ["base"],
  "axes": {
    "axis.loose-representation": {
      "tells": [
        { "kind": "regex", "query": "interface\\{\\}", "description": "empty interface — the domain type is wider than reality" },
        { "kind": "regex", "query": "\\.\\([A-Z][\\w.]*\\)(?!\\s*,\\s*ok)", "description": "unchecked type assertion (no comma-ok) — panics instead of narrowing" },
        { "kind": "ast", "query": "struct with 3+ bool fields never independently true", "description": "a disguised enum; prefer an iota type" }
      ]
    },
    "axis.reinvention": {
      "primitives": [
        { "rebuilds": "manual JSON unmarshal + ad-hoc validation", "use": "struct tags + a validator (go-playground/validator) or encoding/json into a typed struct" },
        { "rebuilds": "a hand-rolled enum via untyped string consts", "use": "a defined `type X string` + exhaustiveness lint (exhaustive)" }
      ]
    },
    "axis.wrong-direction": {
      "tells": [
        { "kind": "tool", "query": "go vet ./...", "description": "some cycle/shadow classes" },
        { "kind": "tool", "query": "depguard / go-arch-lint layer rules", "description": "stable package importing app-specific one" }
      ]
    },
    "axis.repetition": {
      "tells": [
        { "kind": "tool", "query": "dupl -threshold 50", "description": "duplicate blocks (tell only)" },
        { "kind": "regex", "query": "if err != nil \\{[\\s\\S]{0,40}?return", "description": "repeated error-handling shape — candidate for a helper ONLY if the sites share one policy (usually they don't — coincidental)" }
      ],
      "exclusions": [
        { "query": "if err != nil { return err }", "reason": "idiomatic Go error propagation is coincidental repetition — DRYing it is the anti-pattern, not the fix" }
      ]
    }
  },
  "tiers": {
    "tier.1-static": { "available": true, "mechanisms": ["go build (type system)", "golangci-lint", "exhaustive linter", "go-arch-lint boundaries"] },
    "tier.2-runtime": { "available": false, "mechanisms": ["validator lib — only if a dependency provides one"] },
    "tier.3-ownership": { "available": true },
    "tier.4-tests": { "available": true, "mechanisms": ["go test"] },
    "tier.5-convention": { "available": true }
  }
}
```

The pre-loaded `exclusions` entry is the important part: Go's `if err != nil`
boilerplate is the textbook **coincidental duplication** the repetition
anti-pattern warns against. Baking it into the language profile stops every Go
review from re-litigating it.

### Sibling — `lang:python`

Python is the case that justifies the `available` **boolean** most sharply: static
enforcement is *partial and repo-dependent*. A repo running `mypy --strict` +
`pydantic` reaches tiers 1 and 2; a duck-typed script reaches neither. The language
profile encodes the *conditional*; discovery resolves it per repo.

```jsonc
{
  "id": "lang:python",
  "extends": ["base"],
  "axes": {
    "axis.loose-representation": {
      "tells": [
        { "kind": "regex", "query": ":\\s*(Any)\\b", "description": "typing.Any — the annotation opting out of checking" },
        { "kind": "regex", "query": "#\\s*type:\\s*ignore|cast\\(", "description": "type: ignore / typing.cast — the code confessing a looser type" },
        { "kind": "ast", "query": "dataclass with 3+ bool flags never independently true", "description": "a disguised enum; prefer enum.Enum" }
      ]
    },
    "axis.reinvention": {
      "primitives": [
        { "rebuilds": "manual dict parsing + isinstance checks", "use": "a pydantic model / dataclass + a validator at the boundary" },
        { "rebuilds": "stringly-typed status consts", "use": "enum.Enum + exhaustiveness via typing.assert_never" }
      ]
    },
    "axis.wrong-direction": {
      "tells": [
        { "kind": "tool", "query": "import-linter contracts", "description": "layer/independence violations & cycles" },
        { "kind": "tool", "query": "pydeps --show-cycles", "description": "import cycle" }
      ]
    },
    "axis.repetition": {
      "tells": [
        { "kind": "tool", "query": "pylint R0801 (duplicate-code)", "description": "duplicate blocks (tell only)" }
      ]
    }
  },
  "tiers": {
    "tier.1-static": { "available": false, "mechanisms": ["mypy/pyright — ONLY if configured strict; discovery sets this"] },
    "tier.2-runtime": { "available": false, "mechanisms": ["pydantic/attrs validation — only if a dependency provides it"] },
    "tier.3-ownership": { "available": true },
    "tier.4-tests": { "available": true, "mechanisms": ["pytest"] },
    "tier.5-convention": { "available": true }
  }
}
```

Both `tier.1-static` and `tier.2-runtime` default to `available: false` here on
purpose: absent evidence (a strict `mypy` config, a `pydantic` dep), Lever D must
**not** propose "make it unrepresentable in the type." Discovery flips them to
`true` when it finds the config/dependency — the conservative default is what keeps
the ladder honest in a dynamically-typed stack.

---

## Worked example — `repo:warden` (the dogfood profile)

Extends `lang:typescript`; adds only what's true of *this* repo. This is where the
ADR-0052 §7 Warden grounding legitimately lives — verify these against current code
before relying on them.

```jsonc
{
  "id": "repo:warden",
  "extends": ["lang:typescript"],
  "sourcesOfTruth": [
    { "path": "packages/…", "symbol": "CATEGORY_BY_CONCERN", "note": "concern→category map — the registry poster child; a new concern must land here" },
    { "path": "packages/…", "symbol": "DEFAULT_TIER_BY_CONCERN", "note": "co-varying sibling map; drift between the two is an axis.repetition tell" }
  ],
  "boundaries": [
    { "stable": "packages/core/**", "forbid": ["**/cli/**", "**/io/**"], "enforcedBy": "tier.1-static: I/O-pure core (ADR-0013)" }
  ],
  "axes": {
    "axis.loose-representation": {
      "exclusions": [
        { "query": "as … at a zod-validated boundary", "reason": "the cast is downstream of a safeParse — parked at a real trust boundary, not a defect" }
      ]
    }
  },
  "dims": {
    "dim.substrate": { "substrate": ["better-sqlite3 (.warden/cache.sqlite)", "OSV.dev API", "the LLM provider"] }
  }
}
```

The `exclusions` here are the **grounded anti-pattern FP traps** ADR-0052's eval
gate (ii) demands, expressed as data: a known-good pattern that matches a tell but
must never be flagged. Every FP the dogfood surfaces becomes one more exclusion —
the profile is where precision debt is paid down.

---

## Discovery — profiling a repo Warden has never seen

Warden reviews arbitrary repos, so most targets have no authored profile. The repo
layer is then **inferred**, cheaply, in Pass 1:

1. **Language** — from file extensions + manifest (`package.json`, `go.mod`,
   `pyproject.toml`) → selects the `lang:*` base.
2. **Substrate** (`dim.substrate`) — from dependencies (an ORM, a queue, a
   provider SDK) → seeds down.authority proof targets.
3. **Tier availability** — from config presence: `tsconfig strict`, a lint config,
   a test runner, a boundary-lint script → sets each `tiers[*].available`.
4. **Sources of truth & boundaries** — from workspace graph + existing
   registries/barrels → seeds `axis.repetition` and `axis.wrong-direction`.

Discovery is best-effort and **conservative**: an *undetected* tier is treated as
`available: false` (so Lever D won't propose enforcement the repo can't hold), and
an authored `.warden/profile.*` in the target always overrides the inference.

---

## How Lever D consumes the effective profile

| Stage | Uses |
| --- | --- |
| **Pass 1 (tells)** | union of `axes[*].tells` **minus** `axes[*].exclusions` → the `<structural-candidates>` block, each tagged with its `axis.*` slug |
| **Pass 2 (pointers)** | the axis pointer from the method doc, run with repo tools; `primitives` answer axis.reinvention directly; `sourcesOfTruth`/`boundaries` answer repetition/wrong-direction |
| **Ladder → confidence → kind** | `tiers[*].available` bounds the strongest reachable tier; unreachable-enforcement proposals demote to questions (ADR-0044) |
| **Gates** | `gate.up.b-anti-pattern` consults `exclusions`; `gate.up.c-enforcement` consults `tiers[*].mechanisms` |

The method stays fixed; only the profile changes per stack. That is the whole point
of the classification: **one search shape, many binding sets.**

---

## Authoring checklist

- Bind to a **slug from the registry** — never invent an ungrounded key.
- A `lang:*` profile holds only what's true of the *language/ecosystem*; anything
  repo-specific belongs in `repo:*`.
- A **tell is not a finding** — keep detectors in `tells`, judgment in the method.
- Prefer setting `tiers[*].available` honestly over listing aspirational
  mechanisms; a false `available: true` produces unreachable-fix proposals.
- Every confirmed false positive from a dogfood run → a new `exclusions` entry, not
  a prompt tweak.
