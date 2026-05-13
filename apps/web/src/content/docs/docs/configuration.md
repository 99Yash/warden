---
title: Configuration
description: Environment variables used by Warden.
---

Warden reads environment variables through the `@warden/env` package. App code should not read
`process.env` directly.

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Primary LLM provider for `warden review`. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | Fallback provider when Anthropic fails transiently. |
| `VOYAGE_API_KEY` | For `warden init` | Embedding-backed context index. |
| `WARDEN_THINKING_BUDGET` | No | Anthropic extended-thinking token budget. |
| `WARDEN_LOG_LEVEL` | No | Controls internal log verbosity. |

## Cache location

Warden stores local cache data at `.warden/cache.sqlite`. The directory is gitignored and can be
rebuilt from source with `warden init`.
