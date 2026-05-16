# scalability-sequential-await

Planted: serial `await` inside a for-of loop where the iterations are
independent. The docstring even hints "up to 200 ids per page render" —
that's 200 sequential round-trips when `Promise.all(ids.map(fetchOne))`
would do them in parallel.

```yaml
id: sequential-await
path: src/fetch-users.ts
line: 12
category: scalability
description: for-of with `await fetch` runs requests in sequence; should fan-out with Promise.all when iterations are independent.
```
