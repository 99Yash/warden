---
title: Overview
description: What Warden does and how to use it.
---

<p class="doc-lede">Warden reviews TypeScript and JavaScript changes by collecting mechanical evidence first, verifying claims second, and using the model only to triage and phrase what survived.</p>

<div class="doc-feature-list" aria-label="Warden review contract">
  <a class="doc-card" href="#review-flow">
    <span class="doc-card-icon">01</span>
    <strong>Tool facts first</strong>
    <p>TSC, ESLint, npm audit, OSV, jscpd, and deterministic detectors produce the initial record.</p>
  </a>
  <a class="doc-card" href="#output-contract">
    <span class="doc-card-icon">02</span>
    <strong>Verified sources</strong>
    <p>External claims need citations that substring-match the cited artifact before a comment ships.</p>
  </a>
  <a class="doc-card" href="#commands">
    <span class="doc-card-icon">03</span>
    <strong>Typed output</strong>
    <p>Every run returns a stable <code>CommentSet</code> for the CLI and future wrappers.</p>
  </a>
</div>

<div class="doc-callout doc-callout-check">
  <strong>Core rule</strong>
  <p>The model is a formatter and triage layer. It is not the source of truth for vulnerabilities, library APIs, repository state, or tool output.</p>
</div>

## Review flow

<ol class="doc-steps">
  <li><span>Detect</span><p>Find the repo root, package manager, diff source, and changed files. The diff-level noise filter prunes generated or irrelevant subtrees before runners start.</p></li>
  <li><span>Run</span><p>Execute deterministic checks: TypeScript, ESLint, dependency audit, duplication, context selection, and category-specific detectors.</p></li>
  <li><span>Verify</span><p>Check external claims against OSV records, package type definitions, or cited repository snippets. Unsupported sources are removed.</p></li>
  <li><span>Format</span><p>Ask the model to order, clarify, and write the review from the verified findings. It can also ask a question when intent is unclear.</p></li>
  <li><span>Return</span><p>Emit a stable <code>CommentSet</code> with comment ids, tiers, categories, confidence, source records, and degraded-worker metadata.</p></li>
</ol>

## Commands

<div class="doc-card-grid">
  <div class="doc-code-card doc-code-card-compact">
    <div class="doc-code-header"><span>Build context index</span><code>once per repo</code></div>
    <pre><code>warden init</code></pre>
    <p>Chunks the codebase, embeds supported languages, and stores the content-addressed index in <code>.warden/cache.sqlite</code>.</p>
  </div>
  <div class="doc-code-card doc-code-card-compact">
    <div class="doc-code-header"><span>Deterministic pass</span><code>no LLM</code></div>
    <pre><code>warden check</code></pre>
    <p>Runs the mechanical checks and deterministic synthesizer. This is the low-friction CI/pre-commit path.</p>
  </div>
  <div class="doc-code-card doc-code-card-compact">
    <div class="doc-code-header"><span>Full review</span><code>LLM triage</code></div>
    <pre><code>warden review</code></pre>
    <p>Adds semantic context selection, committability triage, and the cited review formatter.</p>
  </div>
</div>

Both review verbs accept <code>--json</code>. <code>review</code> also supports <code>--base</code>, <code>--stdin</code>, and <code>--verbose</code> when you need explicit diff control or machine-readable output.

## Output contract

<div class="doc-property-list">
  <div><code>comments[]</code><span>Stable review comments with ids, file ranges, tiers, categories, claims, suggestions, and verified sources.</span></div>
  <div><code>degradedWorkers[]</code><span>Structured notes when a worker is missing context, partially fails, or intentionally refuses a weak finding.</span></div>
  <div><code>metadata</code><span>Runtime context such as mode, base branch, cache behavior, and runner phase information.</span></div>
</div>

That contract is why the CLI can stay one-shot while future GitHub, Slack, or ClickUp surfaces render the same result without scraping terminal output.
