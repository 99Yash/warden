# security-eval-injection

Planted: `eval(req.body.code)` — textbook RCE. ESLint-security's
`detect-eval-with-expression` should also fire, but we measure here whether
the boss surfaces it through the security worker into the final comment
set.

```yaml
id: eval-rce
path: src/exec-handler.ts
line: 13
category: security
description: eval() on user-controlled request body; RCE vector.
```
