---
title: Install
description: Install Warden and run the CLI locally.
---

<p class="doc-lede">Use the workspace commands while Warden is under active development. The published CLI target is already shaped, but npm publication is separate from this site scaffold.</p>

## From this workspace

<ol class="doc-steps doc-steps-compact">
  <li><span>Install dependencies</span><p>Use the pinned pnpm workspace so every package resolves against the same lockfile.</p></li>
  <li><span>Build packages</span><p>Compile the package outputs used by local CLI runs and static site fixtures.</p></li>
  <li><span>Initialize the index</span><p>Create the local embedding-backed context index. Re-running is safe and cache-aware.</p></li>
  <li><span>Run a review</span><p>Start with <code>check</code> for deterministic-only output, or <code>review</code> for the full cited review spine.</p></li>
</ol>

<div class="doc-code-card">
  <div class="doc-code-header"><span>Workspace setup</span><code>local clone</code></div>
  <pre><code>pnpm install
pnpm build
pnpm warden init
pnpm warden review</code></pre>
</div>

## As a CLI

<div class="doc-code-card">
  <div class="doc-code-header"><span>Published target</span><code>future npm path</code></div>
  <pre><code>npx warden review</code></pre>
  <p>The npm publication step is separate from this site scaffold.</p>
</div>

## Required credentials

<div class="doc-property-list">
  <div><code>ANTHROPIC_API_KEY</code><span>Required for <code>warden review</code>. Warden validates it at startup so failures are explicit.</span></div>
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
