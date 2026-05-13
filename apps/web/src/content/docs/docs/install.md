---
title: Install
description: Install Warden and run the CLI locally.
---

## From this workspace

```bash
pnpm install
pnpm build
pnpm warden init
pnpm warden review
```

## As a CLI

The published CLI target is:

```bash
npx warden review
```

The npm publication step is separate from this site scaffold.

## First run

Run `warden init` once per repository to build the local context index. Re-running it is safe and
uses cached work where possible.
