# leverage-stringify-clone

Planted: `JSON.parse(JSON.stringify(node))` deep-clone idiom — should be
`structuredClone(node)` per modern Node stdlib (≥17.0). Caught by the
leverage detector and/or the leverage worker.

```yaml
id: stringify-clone
path: src/clone.ts
line: 10
category: leverage
description: JSON.parse(JSON.stringify(x)) deep-clone — structuredClone() is the modern stdlib replacement.
```
