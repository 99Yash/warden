# correctness-off-by-one

Planted: classic off-by-one in `sumFirstN` — the for loop uses `i <= limit`
when it should be `i < limit`. The current code reads `values[limit]` which
returns `undefined` for `limit === values.length`, masking via `?? 0` so
small inputs pass. Caught by careful inspection of loop bounds.

```yaml
id: off-by-one
path: src/array-sum.ts
line: 8
category: correctness
description: for-loop uses `i <= limit` instead of `i < limit`; reads one element past `n` (or one past the end when n >= length).
```
