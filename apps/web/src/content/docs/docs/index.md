---
title: Overview
description: What Warden does and how to use it.
---

Warden is a local code review CLI for TypeScript and JavaScript repos.

It runs the checks that can be trusted mechanically, verifies claims that reach outside the
codebase, and then uses a model for the part models are good at: sorting, phrasing, and asking when
intent is unclear.

## Review flow

1. Detect the repository shape and diff scope.
2. Run TypeScript, ESLint, dependency audit, duplication, and deterministic detectors.
3. Verify external claims before they become comments.
4. Select adjacent code context.
5. Produce a typed `CommentSet` for the CLI and future wrappers.

## Commands

```bash
warden init
warden check
warden review
```

`warden check` is deterministic-only. `warden review` adds model-assisted triage and wording.

## Output contract

Every review produces comments with stable ids, file ranges, tiers, categories, confidence, and
sources. Future wrappers can consume the same JSON contract without scraping terminal output.
