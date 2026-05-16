# committability-debugger-leftover

Planted: `debugger;` statement plus a leftover `console.log` in a parser
function. Clear "shouldn't have been committed" pattern.

```yaml
id: debugger-leftover
path: src/parser.ts
line: 8
category: committability
description: debugger statement left in production code.
```
