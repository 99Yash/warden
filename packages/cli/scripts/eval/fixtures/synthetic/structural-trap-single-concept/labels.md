# structural-trap-single-concept

ADR-0052 eval leg (ii), the conflation anti-pattern: a genuine single concept
that must **not** be split. Synthetic, two new files, so the sparse tree holds
the whole bait.

The bait: `upsertProfile` says "insert it, or update the row". An "or" in the
true description is the conflation tell, so a reviewer proposes a split into
`createProfile` and `updateProfile` (or a check-then-write).

Why it is a trap: the domain operation is one concept, "the stored profile of
this user is now this value". The single `INSERT ... ON CONFLICT DO UPDATE`
statement is what makes it race-free: two concurrent saves for a new user
cannot both insert, and no caller has to know if the row existed (`PUT` is
idempotent). A split moves the choice to the caller and opens a
check-then-act race, which is the over-decomposition the axis warns about
(gate B fails: the two halves do not change independently). The change is
otherwise clean: the route takes the user id from the session, not the body.

Scoring: a path-only `expect: absent` label on the upsert file. Any comment
on it is a trap hit (gate (f), any sample).

```yaml
id: upsert-must-not-be-split
expect: absent
path: src/profiles/upsert-profile.ts
description: [structural] [trap] conflation anti-pattern. "Insert or update" is one atomic save (ON CONFLICT DO UPDATE); splitting it into create/update moves the choice to callers and adds a check-then-act race.
```
