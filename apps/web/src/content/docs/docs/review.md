---
title: Review pipeline
description: What `warden review` runs today, what it verifies, and where deep security fits later.
---

<p class="doc-lede"><code>warden review</code> is the everyday cited-review path: deterministic producers and scoped sub-agents feed the orchestration spine, the boss model synthesizes a <code>CommentSet</code>, and the verifier drops unsupported claims.</p>

<div class="doc-callout doc-callout-note">
  <strong>Current boundary</strong>
  <p>The deep security harness is design-locked, but not part of this default surface. This page describes the shipped review path.</p>
</div>

## Review phases

<ol class="doc-steps">
  <li><span>Diff and noise filter</span><p>Resolve the review diff, detect the ecosystem, and prune generated or irrelevant subtrees before runners start.</p></li>
  <li><span>Deterministic producers</span><p>Run TypeScript, ESLint, npm audit plus OSV, jscpd, context selection, scalability, deadcode, consistency, leverage, and Warden-managed security lint.</p></li>
  <li><span>Scoped sub-agents</span><p>In review mode, committability, library leverage, and security triage sub-agents ask bounded questions when structural tools are not enough.</p></li>
  <li><span>Synthesis</span><p>The boss model orders findings by priority, chooses the clearest framing, and emits the typed <code>CommentSet</code> shape.</p></li>
  <li><span>Verification</span><p>Repository snippets, OSV advisory records, and <code>api_def</code> type-definition citations are substring-verified. Comments left without verified sources are dropped.</p></li>
</ol>

## What review adds beyond check

<div class="doc-property-list">
  <div><code>context selection</code><span>Cheap signals and, after <code>warden init</code>, embedding-backed candidates give the formatter nearby code with evidence ranges.</span></div>
  <div><code>committability</code><span>A cheap-tier sub-agent asks about merge-readiness risks that are too repository-specific for a reliable detector.</span></div>
  <div><code>leverage</code><span>A deterministic detector catches bounded stdlib swaps; a sub-agent can ask about library substitutions after checking installed <code>.d.ts</code> definitions.</span></div>
  <div><code>security</code><span>A Warden-managed ESLint security pass runs in both modes; review also adds a Haiku triage sub-agent for security residue, subject to a confidence floor and citation verification.</span></div>
</div>

<div class="doc-callout doc-callout-check">
  <strong>Verifier veto</strong>
  <p>The formatter can lower confidence or ask a question, but it cannot rescue a claim whose cited source fails verification.</p>
</div>

## Deep security status

<div class="doc-code-card">
  <div class="doc-code-header"><span>Planned deep surfaces</span><code>direction</code></div>
  <pre><code>warden security
warden review --deep</code></pre>
  <p>These are planned as opt-in deep security paths with a dedicated harness. They are not aliases: the verb is focused SAST; the flag means normal review plus deep security. Marketing them before the shipped review loop feels right would overstate the current product.</p>
</div>

## Output contract

<p>The review result is still the same <code>CommentSet</code> consumed by the examples page and future wrappers. The important part is that every producer, whether deterministic or LLM-backed, has to fit the same comment, source, confidence, tier, and degraded-worker contract.</p>
