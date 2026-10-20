# structural-misplacement-fold-consumer (alfred `b56ae1c8e`, "Ingress: replace the EVENT_SOURCES enum with a typed inbound source registry behind one route")

ADR-0052 eval leg (i), misplacement axis. `diff.patch` is only two sections of
`b56ae1c8e`: the new
`packages/assistant/src/runtime/adapters/github-activity-consumer.ts` (74
lines) and its 2-line registration in `trigger-consumers.ts`. The full commit
has 36 files and a 12,380-line migration snapshot, so the fixture keeps the
part that holds the defect. `meta.json` checks out `b56ae1c8e`, so the lane can
read the object-state owner (`packages/assistant/src/connections/object-state/`)
that the consumer drives.

The code: `githubActivityTriggerConsumer` turns a GitHub receipt into object
state. It writes `webhook_events` and calls `objectStateStore.applyEvent`
(line 64). The reducer and the store that it drives live under
`connections/object-state`. The consumer lives under `runtime/adapters`, a
folder for runtime wiring. So a reader cannot recover the GitHub fold
lifecycle from the folder shape, and a change to the object-state fold must
look in a second, unrelated folder. The registration line in
`trigger-consumers.ts` is the only part that is runtime wiring. Category
`clarity` (misplacement). The fix is a move to the owner (tier 3: the
object-state owner holds the code that feeds it, and its barrel is the one
door).

Why it is genuine: alfred issue #986 ("Ingress: move the GitHub fold consumer
beside the object-state reducer it drives") names this defect: "The consumer
that turns a GitHub receipt into object state lives under runtime adapters.
The reducer and store it drives live under the object-state owner. A reader
cannot recover the GitHub lifecycle from the folder shape." The later fix
`3e30dcb0e` ("refactor(assistant): move the GitHub fold consumer beside the
object-state reducer", "Closes #986") moves the file to
`connections/object-state` and leaves only the registration line in
`trigger-consumers.ts`.

Not labeled: the same consumer also writes `webhook_events`, which issue #975
calls a duplicate write. That is a separate finding.

Anchor note: the label is on the consumer's declaration (line 22). A finding
anchored only on the import on line 5 or the `applyEvent` call on line 64
reads as a miss.

```yaml
id: github-fold-consumer-outside-object-state-owner
path: packages/assistant/src/runtime/adapters/github-activity-consumer.ts
line: 22
category: clarity
description: [structural] misplacement. The GitHub activity fold consumer drives objectStateStore.applyEvent (connections/object-state) but lives under runtime/adapters; only its registration is runtime wiring. Issue #986; fixed by 3e30dcb0e (moved beside the object-state reducer, registration line kept in trigger-consumers.ts).
```
