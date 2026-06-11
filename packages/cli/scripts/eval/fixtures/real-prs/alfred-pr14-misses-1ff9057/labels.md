# alfred-pr14-misses (alfred PR#14, "Codex/dimension preview UI", merged 2026-05-20)

After the user dogfooded `warden init` + `warden review` on `99Yash/alfred#14`,
Devin posted 4 inline findings that warden's M14 review missed. Three of
the four (bugs 2, 3, 4 below) are real PR-state misses; the fourth (bug 1 —
white-on-white Tabs pill from `--gray-50` / `--gray-1000` lightness
collision) was introduced by warden's own fix commit `94e0cab` and is
documented in `docs/dogfood-backlog.md` as a repo-overlay candidate
explicitly out of warden core scope, so it is NOT labeled here. See the
`project_warden_alfred_pr14_misses` memory for full origin context.

The three labeled bugs are all UI/runtime-behavior bugs in changed files —
exactly the area `project_warden_review_category_gaps` named as warden's
weakest: the LLM has no rendering pass and no diff-vs-prior-callsite
comparison. The Sentry-Warden prompt borrows (adversarial voice + 7-step
investigation procedure + category × trigger table + severity tie-breaker)
target the prompt-craft side of that gap; bugs 2 and 3 are also queued as
backlog detector candidates per ADR-0035.

```yaml
id: filter-tabs-slice-1-ui-dead-state
path: apps/web/src/routes/library.tsx
category: correctness
description: items={FILTER_TABS.slice(1)} drops the "all" tab from a Radix Tabs primitive that has no re-click-to-deselect. The default filter="all" state becomes reachable only on first paint — once a user clicks any other tab, the unfiltered view is gone until reload. Backlog detector candidate (dogfood-backlog §1 "UI state reachability").
```

```yaml
id: settings-refactor-lost-navigate
path: apps/web/src/routes/settings.tsx
category: correctness
description: Sign-out logic moved from DangerSection to UserSection during a UI parity pass; the pre-refactor `await navigate({to:"/login"})` after `authClient.signOut()` was silently dropped on the move. Both sections look internally consistent in isolation; the missing call is only visible against the pre-refactor version. Backlog detector candidate (dogfood-backlog §2) plus an active prompt delta in correctness-system.md.
```

```yaml
id: text-offset-vs-prosemirror-position-unit-mismatch
path: apps/web/src/routes/index.tsx
category: correctness
description: editorCaretTextOffset returns text-space length (paragraph break = 1 char); insertMention consumes it as a ProseMirror position (paragraph break = 2 positions). Both sides are typed `number`, so the type system is blind. Pure prompt-delta candidate; active note in correctness-system.md under "Unit / coordinate-space mismatch."
```
