---
title: Overview
description: What Warden does, how it splits the work with your agent runtime, and how to use it.
---

<p class="doc-lede">Warden is the ground truth for an AI code review. It runs the deterministic checks, serves them to your agent runtime over MCP, and publishes only the findings that pass gates the model cannot skip.</p>

<div class="doc-feature-list" aria-label="Warden review contract">
  <a class="doc-card" href="#review-flow">
    <span class="doc-card-icon">01</span>
    <strong>Evidence over MCP</strong>
    <p>TSC, ESLint, npm audit with OSV, duplication, security lint, and real <code>.d.ts</code> lookups, served as versioned tools.</p>
  </a>
  <a class="doc-card" href="#review-flow">
    <span class="doc-card-icon">02</span>
    <strong>Lanes in your runtime</strong>
    <p>Review agents run in your MCP client — OpenCode first — with read-only tools.</p>
  </a>
  <a class="doc-card" href="#output-contract">
    <span class="doc-card-icon">03</span>
    <strong>Post-pass decides</strong>
    <p>Citations, scope, confidence, and volume are checked outside the model before a stable <code>CommentSet</code> ships.</p>
  </a>
</div>

<div class="doc-callout doc-callout-check">
  <strong>Core rule</strong>
  <p>The model reads, reasons, and phrases. It is not the source of truth for vulnerabilities, library APIs, repository state, or tool output, and it never decides on its own what gets published.</p>
</div>

## Why the split

The review loop — sub-agents, model routing, permissions, sessions — is solved again with every model release, and general agent runtimes solve it well. A detector corpus, verified advisories, a repo index, and an eval harness are not something a runtime ships. So Warden keeps the method and the gates and hands the loop to the runtime. [ADR-0053](https://github.com/99Yash/warden/blob/main/decisions.md) records the decision.

## Review flow

<ol class="doc-steps">
  <li><span>Diff</span><p>Resolve the base by merge-base, prune generated files, and reject unsafe input such as a symlink that leaves the repository.</p></li>
  <li><span>Det-priors</span><p>The lane calls <code>run_det_priors</code> first. Warden runs the deterministic checks and returns a bounded, paged bundle.</p></li>
  <li><span>Lanes</span><p>Lanes investigate in your runtime. The down lane proves invariants; the up lane searches for structural drift. The six concerns — correctness, scalability, consistency, security, committability, leverage — are focus areas inside a lane.</p></li>
  <li><span>Post-pass</span><p>Verify each citation by substring against the repo, OSV, or the package's type definitions. Keep each finding inside its lane's file scope, screen secrets, apply confidence and volume rules.</p></li>
  <li><span>Publish</span><p>Emit one stable <code>CommentSet</code>. Lane prose never reaches you directly.</p></li>
</ol>

## Commands

<div class="doc-card-grid">
  <div class="doc-code-card doc-code-card-compact">
    <div class="doc-code-header"><span>MCP server</span><code>stdio</code></div>
    <pre><code>warden mcp</code></pre>
    <p>Serves Warden's tools to any MCP client. See <a href="/docs/mcp/">MCP and OpenCode</a>.</p>
  </div>
  <div class="doc-code-card doc-code-card-compact">
    <div class="doc-code-header"><span>Lane review</span><code>OpenCode</code></div>
    <pre><code>warden opencode-review</code></pre>
    <p>Runs a lane in OpenCode and publishes only the post-pass result.</p>
  </div>
  <div class="doc-code-card doc-code-card-compact">
    <div class="doc-code-header"><span>Deterministic pass</span><code>no LLM</code></div>
    <pre><code>warden check</code></pre>
    <p>Runs the mechanical checks only. The low-friction CI and pre-commit path.</p>
  </div>
</div>

<code>warden init</code> builds the embedding-backed context index once per repo. <code>warden review</code> still runs the original in-process review loop and stays the default until the parity eval clears; see <a href="/docs/review/">Review pipeline</a>.

## Output contract

<div class="doc-property-list">
  <div><code>comments[]</code><span>Stable review comments with ids, file ranges, tiers, categories, claims, suggestions, and verified sources.</span></div>
  <div><code>degradedWorkers[]</code><span>Structured notes when a lane or detector is missing context, partly fails, or refuses a weak finding.</span></div>
  <div><code>metadata</code><span>Run context such as mode, base branch, cost, and phase timings.</span></div>
</div>

Every path — `check`, `review`, `opencode-review`, and `post-pass` — emits this same contract, so a CI job or a bot renders the result without scraping terminal output.
