---
title: Configuration
description: Where Warden reads its settings and keys, every environment variable it understands, and what lives in the local cache.
---

<p class="doc-lede">Warden keeps settings and secrets apart. Settings go in config files. Keys stay in the environment, so your shell, your secret manager, and your CI secrets all work without extra steps.</p>

## Where settings come from

Config files are read in three layers, and each later layer overrides the earlier ones:

1. Warden's built-in defaults.
2. Your global config, `~/.config/warden/config.jsonc`, which `warden setup` creates.
3. The repository's `warden.jsonc`, which `warden setup project` creates.

A config file can name the environment variable that holds a key (`apiKeyEnv`), but it can't contain the key itself.

Keys and other variables are read in this order, and the first value found wins:

1. The process environment, from your shell, CI, or tools like Doppler, Infisical, or 1Password.
2. The env files your config names, such as `~/.config/warden/env`.
3. The repository's `.env` and `.env.local`.

To add one extra env file for a single run, set `WARDEN_ENV_FILE=/path/to/file`.

`warden mcp` is the exception. It loads no env files and keeps only a short allowlist of variables, so provider keys and CI tokens never reach the MCP server or the detectors it starts. See [Untrusted input](/docs/untrusted-input/#what-the-agent-is-allowed-to-do).

## Providers

None of these are needed for `check`, `mcp`, `opencode-review`, or `post-pass`. On the OpenCode path, the model and its credentials belong to OpenCode.

<div class="doc-property-list doc-env-list">
  <div><code>ANTHROPIC_API_KEY</code><span>For <code>warden review</code>. When set, the boss model is Claude Opus.</span></div>
  <div><code>OPENAI_API_KEY</code><span>For <code>warden review</code>. When it's set, OpenAI models do the worker calls. With only this key, OpenAI runs the whole review.</span></div>
  <div><code>VOYAGE_API_KEY</code><span>Needed by <code>warden init</code>, except with <code>--dry-run</code>, to embed the repository with <code>voyage-code-3</code>. Without it, <code>warden review</code> selects context from cheaper signals.</span></div>
  <div><code>GOOGLE_GENERATIVE_AI_API_KEY</code><span>Optional. Gives a Google fallback when an Anthropic call fails transiently. Calls that use tools, which includes the review loop, don't fall back.</span></div>
</div>

## General

<div class="doc-property-list doc-env-list">
  <div><code>WARDEN_LOG_LEVEL</code><span><code>silent</code>, <code>error</code>, <code>warn</code>, <code>info</code> (the default), or <code>debug</code>.</span></div>
  <div><code>WARDEN_ENV_FILE</code><span>One extra env file to load for this run.</span></div>
  <div><code>WARDEN_CACHE_PATH</code><span>Where the SQLite cache lives. The default is <code>&lt;repo&gt;/.warden/cache.sqlite</code>. A relative path resolves against the current directory.</span></div>
  <div><code>WARDEN_REACT_DOCTOR</code><span>Set to <code>1</code> to add the <code>react-doctor</code> rules to the deterministic phase. Off by default.</span></div>
</div>

## Review tuning

These variables affect `warden review`, the in-process loop. The OpenCode path takes its settings from command flags instead. See [Connect OpenCode](/docs/mcp/#options).

<div class="doc-property-list doc-env-list">
  <div><code>WARDEN_SECURITY_CONFIDENCE_FLOOR</code><span>A number from <code>0.0</code> to <code>1.0</code> that overrides the confidence bar for <code>security</code> findings. The default is 0.8. Tier 1 findings ignore it.</span></div>
  <div><code>WARDEN_REVIEW_BOSS_ROUNDS</code><span>The boss loop's step limit, from 1 to 10. The default is 5.</span></div>
  <div><code>WARDEN_REVIEW_WORKER_BUDGET</code><span>The most workers one review can dispatch. Unlimited by default.</span></div>
  <div><code>WARDEN_WORKER_CONCURRENCY_STRONG</code><span>How many strong-tier workers can run at once. The default is 4.</span></div>
  <div><code>WARDEN_WORKER_CONCURRENCY_CHEAP</code><span>How many cheap-tier workers can run at once. The default is 8.</span></div>
  <div><code>WARDEN_REVIEW_REFRESH_MAX_USD</code><span>A dollar cap on re-embedding stale files during a review. The default is 0.25.</span></div>
  <div><code>WARDEN_SECURITY_WORKER_BUDGET</code><span>A cap on workers for the deep security review.</span></div>
</div>

## Tracing

Warden can send review traces to a self-hosted [Langfuse](https://langfuse.com). Tracing is off unless both keys are set. Traces contain the source code under review, so by default Warden refuses any host that isn't on your machine.

<div class="doc-property-list doc-env-list">
  <div><code>LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY</code><span>Turn tracing on.</span></div>
  <div><code>LANGFUSE_HOST</code><span>The default is <code>http://localhost:3200</code>. Remote hosts are refused.</span></div>
  <div><code>WARDEN_LANGFUSE_ALLOW_REMOTE</code><span>Set to <code>1</code> to allow a remote self-hosted instance on purpose.</span></div>
  <div><code>WARDEN_LANGFUSE_CAPTURE_IO</code><span>Records full prompts and completions. On by default when tracing is on. Set it to <code>0</code> for any CI or cloud run.</span></div>
</div>

## The local cache

Warden keeps its state in one SQLite file, `.warden/cache.sqlite` at the repository root. The file is gitignored. It holds the chunks, embeddings, and Merkle state for the index, the import graph, cached type-definition lookups, and a record of each review run. You can delete it at any time. `warden init` rebuilds the index, and everything else is filled in again as it's needed.

Your code stays on your machine except for three kinds of call: embeddings to Voyage when you run `init`, model calls to the provider you've configured, and advisory checks against OSV.dev. On the OpenCode path, everything the lane reads goes to the model you set up in OpenCode.
