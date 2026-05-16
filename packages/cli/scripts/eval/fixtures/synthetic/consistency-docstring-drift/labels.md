# consistency-docstring-drift

Planted: docstring claims the cache "holds at most 500 entries" but the
constant `MAX_ENTRIES = 1000`. Classic doc-vs-code drift the consistency
worker is designed to catch.

```yaml
id: docstring-drift
path: src/cache.ts
line: 4
category: consistency
description: Docstring says "at most 500 entries" but MAX_ENTRIES = 1000.
```
