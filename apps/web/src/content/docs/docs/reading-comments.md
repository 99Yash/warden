---
title: Reading comments
description: Understand Warden tiers, categories, citations, and degraded-worker notes.
---

## Tiers

| Tier | Meaning |
| --- | --- |
| 1 | Blocking issue. Fix before merging. |
| 2 | Real issue or risk. Usually worth fixing in the current change. |
| 3 | Style, cleanup, or lower-confidence concern. Hidden unless verbose output asks for it. |

## Categories

Warden orders comments by review priority: correctness, security, vulnerability, contract,
scalability, consistency, deadcode, committability, clarity, style, deduplication, then tests.

## Sources

Comments include sources where Warden can cite a tool, repository line, advisory, or external
record. A claim without acceptable grounding should be dropped rather than shown.

## Degraded workers

The metadata can include degraded entries when a worker is missing context or had a partial failure.
Actionable entries appear in the normal CLI output; warnings and info are available in JSON or verbose
mode.
