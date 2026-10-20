---
title: Install
description: Install Warden and run the CLI locally.
---

<p class="doc-lede">Run Warden from a local checkout while it is under active development. It is not published to npm yet.</p>

## From this workspace

<ol class="doc-steps doc-steps-compact">
  <li><span>Install dependencies</span><p>Use the pinned pnpm workspace so every package resolves against the same lockfile.</p></li>
  <li><span>Build packages</span><p>Compile the package outputs used by local CLI runs and static site fixtures.</p></li>
  <li><span>Initialize the index</span><p>Create the local embedding-backed context index. Re-running is safe and cache-aware.</p></li>
  <li><span>Run a review</span><p>Start with <code>check</code> for deterministic-only output. Connect an MCP client, or run <code>opencode-review</code>, for a lane review.</p></li>
</ol>

<div class="doc-code-card">
  <div class="doc-code-header"><span>Workspace setup</span><code>local clone</code></div>
  <pre><code>pnpm install
pnpm build
pnpm warden setup
pnpm warden init
pnpm warden check
pnpm warden opencode-review --base main</code></pre>
</div>

## As an MCP server

<div class="doc-code-card">
  <div class="doc-code-header"><span>From any repository</span><code>stdio</code></div>
  <pre><code>pnpm warden mcp</code></pre>
  <p>Your MCP client starts this process. See <a href="/docs/mcp/">MCP and OpenCode</a> for the client config and the local-checkout command form.</p>
</div>

## Required credentials

<div class="doc-property-list">
  <div><code>ANTHROPIC_API_KEY</code><span>Recommended for <code>warden review</code>, the in-process path. <code>warden check</code>, <code>warden mcp</code>, and <code>warden opencode-review</code> do not need a Warden provider key: on the MCP path the lane model belongs to your runtime.</span></div>
  <div><code>VOYAGE_API_KEY</code><span>Required for <code>warden init</code> and semantic context indexing. Without it, review falls back to cheap signals.</span></div>
  <div><code>GOOGLE_GENERATIVE_AI_API_KEY</code><span>Optional fallback when Anthropic has a transient provider failure.</span></div>
</div>

<div class="doc-code-card">
  <div class="doc-code-header"><span>.env</span><code>local only</code></div>
  <pre><code>ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...</code></pre>
</div>

## First run

<div class="doc-callout doc-callout-note">
  <strong>Cache behavior</strong>
  <p><code>warden init</code> writes the local index to <code>.warden/cache.sqlite</code>. The file is gitignored, can be deleted, and can be rebuilt from source.</p>
</div>
