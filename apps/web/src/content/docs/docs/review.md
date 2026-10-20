---
title: Review pipeline
description: How a Warden review runs on the MCP path, what the in-process path still does, and where the cutover stands.
---

<p class="doc-lede">A Warden review has three phases. Warden owns the first and the last: deterministic evidence before the model, and deterministic gates after it. The middle phase — the lanes — runs in your agent runtime.</p>

<div class="doc-callout doc-callout-note">
  <strong>Two paths, one contract</strong>
  <p><code>warden opencode-review</code> runs the MCP path described here. <code>warden review</code> still runs the original in-process boss loop and stays the default until the parity eval shows the MCP path matches it on recall and precision. Both emit the same <code>CommentSet</code>.</p>
</div>

## Phases

<ol class="doc-steps">
  <li><span>Det-priors</span><p>Resolve the diff, detect the ecosystem, prune generated files, then run TypeScript, ESLint, npm audit with OSV, jscpd, context selection, scalability, deadcode, consistency, leverage, and Warden-managed security lint. Served to lanes as <code>run_det_priors</code>.</p></li>
  <li><span>Lanes</span><p>Agents in your runtime investigate with read-only tools — <code>read</code>, <code>grep</code>, <code>glob</code> — plus Warden's MCP tools. Each lane submits findings as JSON. The driver, not the model, records which files each lane was allowed to cite.</p></li>
  <li><span>Post-pass</span><p>Substring-verify every citation, drop findings outside the lane's file scope or off the added lines, screen secrets, turn low-confidence assertions into questions, apply the volume cap, and emit the <code>CommentSet</code>.</p></li>
</ol>

## Lanes

The method has three motions plus a judge. The six concerns are focus areas inside a motion, not lanes of their own.

<div class="doc-property-list">
  <div><code>down</code><span>Invariant proof. Starts from a behavior the change claims and traces it through callers, state, persistence, and failure until the paths hold or a counterexample breaks them. Shipped; the default lane.</span></div>
  <div><code>up</code><span>Structural search. Infers a better domain shape and measures the change against it: one fact with many homes, a seam in the wrong place, a dependency that points the wrong way. Shipped behind <code>--lane up</code>.</span></div>
  <div><code>surface</code><span>Rule-guided sweep over the deterministic findings. Not shipped yet.</span></div>
  <div><code>judge</code><span>Synthesis and adjudication across lanes. Not shipped yet.</span></div>
</div>

The method's order is "fund up first, earn down selectively": structure comes before local nits, so local findings do not anchor the synthesis.

## Post-pass

<div class="doc-property-list">
  <div><code>citations</code><span>Repository snippets, OSV advisory records, and <code>api_def</code> type-definition citations are substring-verified. A comment with no verified source is dropped.</span></div>
  <div><code>scope</code><span>Each finding must cite files inside its lane's trusted scope envelope and anchor on an added line.</span></div>
  <div><code>secrets</code><span>Findings that would echo a credential or cite a secret file are screened out before output.</span></div>
  <div><code>confidence</code><span>A low-confidence assertion becomes a question. Demotion never drops a finding.</span></div>
  <div><code>tier 3</code><span>Style and dedup findings are gated unless you pass <code>--verbose</code>.</span></div>
  <div><code>volume</code><span>At most five comments by default. Tier 1 is always kept.</span></div>
</div>

<div class="doc-callout doc-callout-check">
  <strong>Verifier veto</strong>
  <p>A lane can lower its confidence or ask a question, but nothing it writes can rescue a claim whose cited source fails verification.</p>
</div>

## Deep security status

<div class="doc-code-card">
  <div class="doc-code-header"><span>Planned deep surfaces</span><code>direction</code></div>
  <pre><code>warden security
warden review --deep</code></pre>
  <p>Opt-in deep security is design-locked but deferred. Under ADR-0053 it becomes a client lane that consumes Warden's tools, not a second harness inside Warden.</p>
</div>
