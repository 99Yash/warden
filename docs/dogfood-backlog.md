# Dogfood backlog — detector candidates

Detector-shaped dogfood lessons (per [ADR-0035](../decisions.md#adr-0035--dogfood-lesson-intake-three-lanes-detector--prompt-delta--repo-overlay-with-retirement-discipline)) awaiting an M-plan slot. When a milestone schedules one of these, lift the entry into the milestone plan (`m{N}-plan.md`) and remove it here. When the detector ships, retire the corresponding prompt delta in the worker prompt per ADR-0035 §2 — otherwise warden double-pays (detector flags it *and* the LLM still hunts for it).

LLM-only residue lives in `packages/core/src/review-harness/prompts/workers/*-system.md` and is audited via `rg "<!-- dogfood:" packages/core/src/review-harness/prompts/`.

---

## 1. UI state reachability detector

**Origin:** alfred PR#14 (2026-05-20). Library filter tabs changed from `items={FILTER_TABS}` (which included `"all"` and `"favourites"`) to `items={FILTER_TABS.slice(1)}`. Radix Tabs has no re-click-to-deselect, so the initial `filter="all"` state became reachable only on first paint — once a user clicked "Favourites", the only ways back to the unfiltered view were page reload or navigation. Caught by Devin, missed by warden's M14 correctness worker.

**Pattern shape:** an items array constructed via `.slice(N)` / `.filter(...)` is passed as a `props.items` (or equivalent) to a single-select primitive (`Tabs`, `RadioGroup`, `Select`, `Combobox`, `ToggleGroup`) where the removed item names the component's initial / default-state value (typically literal `"all"`, `"none"`, `"default"`, or matches the component's `defaultValue` prop / `value` initial-state).

**Inputs the detector needs:**

- Diff + AST (M5's `TsCompilerParser`).
- A configurable allow-list of single-select primitive names (start with the Radix and shadcn defaults: `Tabs`, `RadioGroup`, `Select`, `ToggleGroup`, `Combobox`; extensible per design system).
- Component-name resolution that survives import aliases (`import { Tabs as FilterTabs }` etc.).

**Lane:** `correctness` finding; tier 1 when the removed state is reachable as the component's initial state at first paint.

**Diff-locality:** the trigger is the `.slice(N)` or `.filter(...)` in an added/modified hunk; the consumer can be elsewhere in the same file (common) or a parent component (needs one-hop traversal). Start with same-file v0; widen to one-hop if dogfood evidence shows misses.

---

## 2. Refactor-lost-behavior detector

**Origin:** alfred PR#14 (2026-05-20). Settings sign-out logic moved from a `DangerSection` component to a `UserSection` component during a UI parity pass; the pre-refactor `await navigate({ to: "/login" })` after `authClient.signOut()` was silently dropped on the move. Both sections look internally consistent in isolation; the missing call is only visible against the pre-refactor version. Caught by Devin, missed by warden.

**Pattern shape:** a diff hunk that *moves* code between functions / components / sections where the old hunk contained a side-effect call (from a configurable name registry) and the new hunk does not. Detector must distinguish "move" from "create new function" to know the side-effect was load-bearing in the original.

**Inputs the detector needs:**

- Diff + git blame on the same logical hunk (to confirm the "moved" lines existed in the pre-diff file).
- A configurable side-effect name registry. v0 candidates: `navigate`, `push`, `replace`, `redirect`, `track`, `await fn()` (any awaited free-function call), known cleanup patterns (`unsubscribe`, `dispose`, `cleanup`, `clearInterval`, `clearTimeout`, `controller.abort`, `removeEventListener`).
- Heuristic for "this is a move" — at least N (≈3) consecutive lines from the removed hunk appear nearly verbatim in the added hunk in another function.

**Lane:** `correctness` finding. Residue (semantic side-effects without a name-list match — custom `useEffect` cleanup, repo-specific telemetry helpers, custom hooks) stays in `correctness-system.md`'s **Refactor-lost behavior** prompt delta until the detector subsumes them.

**Diff-locality:** entirely diff-local once git blame is in hand. No cross-file resolution required.

---

## Repo-overlay candidates (not detectors)

Documented for later when `.reviewbot/overlay.yaml` (the path ADR-0008 reserved for known-debt overrides) earns its first concrete runtime consumer.

### Tailwind token-collision check

**Origin:** alfred PR#14, bug 1 — Radix Tabs migration in `tabs.tsx` carried `bg-white/90` but flipped active text from `text-gray-50` (dark in alfred's inverted gray scale) to `text-gray-1000` (white), producing invisible white-on-white pill labels.

**Why this is overlay, not core:** detection requires the design system's CSS variable values (alfred uses `--gray-50: 28 28 28; --gray-1000: 255 255 255` — the opposite of conventional Tailwind). Warden core has no way to know the lightness of a token without reading the repo's CSS. An overlay can encode the lightness map and run a deterministic check.

**Rule shape (for the future overlay):** flag class strings that combine `bg-{X}` and `text-{Y}` where the design-system lightness of `X` and `Y` differs by less than a configurable delta (e.g., < 30 on a 0–255 scale).

---

## Update protocol

When adding a new entry:

1. Confirm it's detector-shaped or overlay-shaped (per ADR-0035 §1) — LLM-only residue does not belong here; it goes straight into the worker prompt with a `dogfood:` audit comment.
2. Lead with **Origin** (`<repo>#<PR>` + date + one-sentence what-warden-missed).
3. Spell out **Pattern shape**, **Inputs**, **Lane**, and **Diff-locality** so a future M-plan slot can be scheduled without re-litigating the design.

When promoting an entry to a milestone:

1. Move the entry verbatim into the corresponding `m{N}-plan.md` under a new deliverable.
2. Delete it from this file.
3. After the detector ships, grep `packages/core/src/review-harness/prompts/workers/` for any `dogfood:` audit comment naming the same origin PR — retire those prompt deltas in the same change per ADR-0035 §2.
