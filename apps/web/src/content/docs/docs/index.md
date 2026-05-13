---
title: Overview
description: What Warden does and how to use it.
---

Warden is an AI code review CLI for TypeScript and JavaScript repos.

It runs deterministic tooling first, verifies external claims, then asks an LLM to triage and format
the review. The model is not the source of truth; it is the final presentation layer.

## Review flow

1. Detect the repository shape and diff scope.
2. Run TypeScript, ESLint, dependency audit, duplication, and deterministic detectors.
3. Verify external claims before showing them.
4. Select adjacent code context.
5. Produce a typed `CommentSet`.

## Commands

```bash
warden init
warden check
warden review
```

`warden check` is deterministic-only. `warden review` adds the LLM triage and formatter.

## Output contract

Every review produces comments with stable ids, file ranges, tiers, categories, confidence, and
sources. Future wrappers can consume the same JSON without scraping terminal output.
