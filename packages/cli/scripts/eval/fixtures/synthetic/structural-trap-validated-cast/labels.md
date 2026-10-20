# structural-trap-validated-cast

ADR-0052 eval leg (ii), the loose-representation anti-pattern: an `as` cast
legitimately parked at a validated boundary. Synthetic, two new files, so the
sparse tree holds the whole bait.

The bait: `raw as Region` in `parseRegion`. A type cast is the axis-5 tell
("the cast is the code confessing its type is looser than reality"), so a
reviewer proposes to remove the cast or to tighten the type.

Why it is a trap: the cast is the boundary. It sits in the one function that
turns a string into a `Region`, right after the membership check that proves
it, and every caller gets the narrow `Region | undefined` type. TypeScript's
`includes` on a readonly tuple does not narrow its argument, so a cast (or a
type predicate whose body does the same check) is the standard form. The
representation is already tight: `Region` derives from the `REGIONS` tuple,
and `loadConfig` rejects an unknown value with the list of known values. The
method says a cast is "not automatically a defect"; here the owning boundary
exists and holds it, so tightening it further freezes nothing new. The change
is otherwise clean.

Scoring: a path-only `expect: absent` label on the region file. Any comment
on it is a trap hit (gate (f), any sample).

```yaml
id: region-cast-at-validated-boundary
expect: absent
path: src/config/region.ts
description: [structural] [trap] loose-representation anti-pattern. raw as Region follows the membership check in the one parse function; the cast is the validated boundary, not a loose type.
```
