---
title: Install
description: Run Warden from a local clone, check your setup, and get a first deterministic result.
---

<p class="doc-lede">Warden isn't on npm yet, so you run it from a clone of the repository. Setup takes a few minutes, and the first useful command needs no API key.</p>

## What you need

- **Node.js 22.18 or newer.** The SQLite driver needs Node 22 or later.
- **pnpm 10.** The repository pins the exact version in `packageManager`, so [Corepack](https://nodejs.org/api/corepack.html) can supply it.
- **Git.** Warden finds the base of a review by merge-base, so it needs the branch history, not a shallow clone.
- **[OpenCode](https://opencode.ai) v2**, only if you want to run review lanes. You can skip it for now.

## Clone and build

```bash
git clone https://github.com/99Yash/warden.git
cd warden
pnpm install
pnpm build
```

Inside the clone, `pnpm warden <command>` runs the CLI. The examples below use that form.

## Check your setup

```bash
pnpm warden setup
```

`setup` creates a global config at `~/.config/warden/config.jsonc` and a template for secrets at `~/.config/warden/env`. Then it reports which providers are ready. To get the report without writing anything, run `pnpm warden setup --check`. If you want settings for one repository only, `pnpm warden setup project` writes a `warden.jsonc` there.

Config files can name the environment variable that holds a key, but they never hold the key itself. Keys come from your shell, your secret manager, or an env file. See [Configuration](/docs/configuration/) for the order Warden reads them in.

## Run the deterministic check

```bash
pnpm warden check
```

`check` runs every deterministic tool against the diff and stops there: TypeScript, ESLint, `npm audit` confirmed against OSV, duplication, Warden's detectors, and the scans of added lines. It makes no model call and needs no key, so it's a good first command and a safe CI gate. Add `--json` for the typed output.

By default `check` looks at your uncommitted changes. To check a whole branch, pass `--base main`, or any other ref, and Warden diffs from the merge-base.

## Which keys you need

Most commands need no key from Warden at all. On the OpenCode path, the model belongs to OpenCode, so the model key does too.

| Command                  | Needs                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `warden check`           | Nothing                                                                               |
| `warden mcp`             | Nothing                                                                               |
| `warden opencode-review` | Nothing from Warden. OpenCode needs its own model credentials.                        |
| `warden post-pass`       | Nothing                                                                               |
| `warden init`            | `VOYAGE_API_KEY`, for embeddings                                                      |
| `warden review`          | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. `VOYAGE_API_KEY` improves context selection. |

## Build the context index (optional)

```bash
pnpm warden init
```

`init` chunks your repository and embeds it with Voyage `voyage-code-3`, which lets `warden review` pick relevant code from outside the diff. The index lives in `.warden/cache.sqlite`. That file is gitignored and safe to delete, and running `init` again rebuilds it. Re-runs only embed what changed. To see the cost estimate without spending anything, use `--dry-run`. To set a ceiling, use `--max-cost <usd>`.

The OpenCode path doesn't use the index yet. A `search_index` tool is planned ([#44](https://github.com/99Yash/warden/issues/44)).

## Next

[Connect OpenCode](/docs/mcp/) to run your first review lane.
