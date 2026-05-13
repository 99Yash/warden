---
title: CI usage
description: Use Warden's deterministic check path in automation.
---

<p class="doc-lede">Use <code>warden check</code> for deterministic CI gates. Use <code>warden review --json</code> only when the pipeline has model credentials and a wrapper can consume the full <code>CommentSet</code>.</p>

<div class="doc-feature-list">
  <a class="doc-card" href="#deterministic-gate"><span class="doc-card-icon">check</span><strong>Deterministic gate</strong><p>No LLM call. Good for fast CI, pre-commit, and failure summaries.</p></a>
  <a class="doc-card" href="#full-review-output"><span class="doc-card-icon">review</span><strong>Full formatter</strong><p>Uses model credentials, semantic context, and citations. Better for PR bots or reports.</p></a>
  <a class="doc-card" href="#minimal-workflow-sketch"><span class="doc-card-icon">json</span><strong>Wrapper contract</strong><p>Stable output for GitHub, Slack, ClickUp, or custom scripts without terminal scraping.</p></a>
</div>

## Deterministic gate

<div class="doc-code-card">
  <div class="doc-code-header"><span>CI-friendly</span><code>no LLM</code></div>
  <pre><code>warden check --json</code></pre>
  <p>Runs the deterministic path and exits after the review completes. This is the safest default for automation that should not spend model tokens.</p>
</div>

## Full review output

<div class="doc-code-card">
  <div class="doc-code-header"><span>Wrapper input</span><code>LLM enabled</code></div>
  <pre><code>warden review --json --base origin/main</code></pre>
  <p>Provides the full typed result for a report or future bot surface. Pass <code>--base</code> when the CI checkout does not expose the same default branch that local review uses.</p>
</div>

<div class="doc-callout doc-callout-note">
  <strong>Current boundary</strong>
  <p>The future GitHub PR bot is a separate app. The current CLI remains one-shot and exits after the review completes.</p>
</div>

## Minimal workflow sketch

<div class="doc-code-card">
  <div class="doc-code-header"><span>GitHub Actions shape</span><code>example</code></div>
  <pre><code>pnpm install --frozen-lockfile
pnpm build
pnpm warden check --json</code></pre>
  <p>Use the workspace command until the package is published. After publication, swap the last line to <code>npx warden check --json</code>.</p>
</div>
