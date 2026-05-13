---
title: Reading comments
description: Understand Warden tiers, categories, citations, and degraded-worker notes.
---

<p class="doc-lede">A Warden comment is a small receipt: actionability tier, review category, confidence, file range, claim, suggested action, and the verified sources that earned the interruption.</p>

## Tiers

<div class="doc-tier-grid">
  <div class="doc-tier tier-one"><span>Tier 1</span><strong>Block</strong><p>Blocking issue. Fix before merging.</p></div>
  <div class="doc-tier tier-two"><span>Tier 2</span><strong>Fix</strong><p>Real issue or risk. Usually worth fixing in the current change.</p></div>
  <div class="doc-tier tier-three"><span>Tier 3</span><strong>Consider</strong><p>Style, cleanup, or lower-confidence concern. Hidden unless verbose output asks for it.</p></div>
</div>

## Categories

<div class="doc-priority-chain" aria-label="Category priority order">
  <span>correctness</span>
  <span>security</span>
  <span>vulnerability</span>
  <span>contract</span>
  <span>scalability</span>
  <span>consistency</span>
  <span>deadcode</span>
  <span>committability</span>
  <span>clarity</span>
  <span>style</span>
  <span>deduplication</span>
  <span>tests</span>
</div>

Categories define reading order, not severity. A Tier 2 correctness finding can appear before a Tier 1 style concern because the review is optimized for what developers should understand first.

## Sources

<div class="doc-property-list">
  <div><code>tool</code><span>Structured output from TSC, ESLint, jscpd, npm audit, or deterministic runners.</span></div>
  <div><code>repository</code><span>A file path, line, and snippet from the reviewed repo. The verifier checks a small line window for a substring match.</span></div>
  <div><code>advisory</code><span>OSV-backed vulnerability records. Advisories without an OSV record are dropped.</span></div>
  <div><code>api_def</code><span>Package type definition lookups for library API claims, cached by package, version, and symbol.</span></div>
</div>

<div class="doc-callout doc-callout-check">
  <strong>Citation discipline</strong>
  <p>A claim without acceptable grounding should be dropped rather than dressed up as certainty.</p>
</div>

## Degraded workers

<div class="doc-code-card">
  <div class="doc-code-header"><span>Metadata shape</span><code>CommentSet</code></div>
  <pre><code>{
  "degradedWorkers": [
    {
      "kind": "actionable",
      "topic": "noise-filter",
      "message": "Skipped generated subtree before runner dispatch."
    }
  ]
}</code></pre>
  <p>Actionable entries appear in the normal CLI output. Warnings and info remain available in JSON or verbose mode.</p>
</div>

<div class="doc-callout doc-callout-note">
  <strong>Why this exists</strong>
  <p>Partial failure is safer when it is visible. Warden should say what did not run instead of silently narrowing the review.</p>
</div>
