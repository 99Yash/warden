---
title: CI usage
description: Use Warden's deterministic check path in automation.
---

Use `warden check` when a pipeline needs deterministic results and no LLM call:

```bash
warden check --json
```

Use `warden review --json` when the pipeline can provide model credentials and wants the full
CommentSet for a wrapper or report.

```bash
warden review --json --base origin/main
```

The future GitHub PR bot is a separate app. The current CLI remains one-shot and exits after the
review completes.
