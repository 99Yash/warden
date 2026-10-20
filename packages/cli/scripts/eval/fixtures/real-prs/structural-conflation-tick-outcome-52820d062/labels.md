# structural-conflation-tick-outcome (alfred `52820d062`, "m12d: workflow trigger dispatch + builtin row seeding (ADR-0027)")

ADR-0052 eval leg (i), conflation axis. `diff.patch` is only the
`packages/api/src/modules/workflows/tick.ts` section of `52820d062` (a new
file, 164 lines). The full commit is large (schema, migration, seeding, and a
smoke), so the fixture keeps the one file that holds the defect. `meta.json`
checks out `52820d062`, so the lane sees the full post-image tree; the rest of
the commit is present in both the base and the head of the fixture repo.

The construct: the outcome union of `dispatchOne`,
`Promise<"enqueued" | "raced">` (line 103), and the `raced` counter of
`TickResult` (line 34). The literal `"raced"` does two jobs:

1. A CAS race loss, line 140: a second tick worker advanced the row first.
   This is normal contention.
2. A malformed cron expression, line 123: `computeNextRunAt` returned null and
   the row leaves the partial index. This is a broken schedule that a user
   must fix.

The two outcomes need opposite operator responses, but one name answers both,
so `raced` in the tick log and in `TickResult` cannot tell contention from a
broken schedule. The change it de-risks: an alert on broken schedules, or a
third outcome, has no place to go without a new case. The fix reaches tier 1:
a third member of the outcome union and a separate counter, so each outcome
has one name. Category `clarity` (conflation).

Why it is genuine: the later fix `ef6a30ad9` ("m12d: distinguish invalid-cron
from CAS race in tick result", "Follow-up on Devin's review") adds
`"invalid"` to the union, returns it on line 123, and adds
`TickResult.invalid` "distinct from CAS races (`raced`) so monitoring can
alert on broken schedules without false positives from legitimate worker
contention."

Anchor note: the lane can also anchor on the union at line 103 or on
`TickResult.raced` at line 34. Those anchors read as a miss for this label.

```yaml
id: raced-outcome-conflates-invalid-cron
path: packages/api/src/modules/workflows/tick.ts
line: 123
category: clarity
description: [structural] conflation. dispatchOne returns "raced" both for a CAS race loss (line 140) and for a malformed cron expression (line 123), so TickResult.raced and the tick log fold a broken schedule into normal contention. Fixed by ef6a30ad9 (a third "invalid" outcome and TickResult.invalid).
```
