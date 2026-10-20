---
title: MCP and OpenCode
description: Connect an MCP client to Warden, run a review lane in OpenCode, and publish through the post-pass.
---

<p class="doc-lede">Warden runs as a local MCP server. Your agent runtime runs the review lanes and calls Warden for evidence. Warden's post-pass then decides what gets published.</p>

<div class="doc-feature-list" aria-label="MCP integration">
  <a class="doc-card" href="#connect-a-client">
    <span class="doc-card-icon">01</span>
    <strong>Connect</strong>
    <p><code>warden mcp</code> serves the tools over stdio to any MCP client.</p>
  </a>
  <a class="doc-card" href="#tools">
    <span class="doc-card-icon">02</span>
    <strong>Call tools</strong>
    <p>Lanes read deterministic evidence and real type definitions on demand.</p>
  </a>
  <a class="doc-card" href="#run-a-lane">
    <span class="doc-card-icon">03</span>
    <strong>Publish</strong>
    <p><code>warden opencode-review</code> runs a lane and publishes only the post-pass result.</p>
  </a>
</div>

<div class="doc-callout doc-callout-check">
  <strong>Gates are not tools</strong>
  <p>A model can decline to call a tool, so a tool cannot be a gate. Citation checks, lane scope, secret screening, confidence rules, and the volume cap run after the lanes return, outside the model.</p>
</div>

## Connect a client

Start the client in the repository you want to review. The server finds the repo root from its launch directory and opens `.warden/cache.sqlite` on demand. A fresh cache migrates itself, so no separate setup step is needed. Stdout carries JSON-RPC only: no banner and no spinner.

<div class="doc-code-card">
  <div class="doc-code-header"><span>opencode.jsonc</span><code>OpenCode v2</code></div>
  <pre><code>{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "warden": { "type": "local", "command": ["warden", "mcp"] }
    }
  }
}</code></pre>
  <p>Run <code>opencode mcp list</code> to check the connection. OpenCode names the tools <code>warden_run_det_priors</code> and <code>warden_lookup_type_def</code>.</p>
</div>

<div class="doc-callout doc-callout-note">
  <strong>Not on npm yet</strong>
  <p>Until Warden is published, point <code>command</code> at a local checkout and set <code>cwd</code> to the repository under review, not the Warden checkout.</p>
</div>

<div class="doc-code-card">
  <div class="doc-code-header"><span>Local checkout</span><code>command</code></div>
  <pre><code>["node", "--import",
 "/abs/path/to/warden/packages/cli/node_modules/tsx/dist/esm/index.mjs",
 "/abs/path/to/warden/packages/cli/src/index.ts", "mcp"]</code></pre>
  <p>The absolute loader path means the reviewed repository does not need <code>tsx</code> installed.</p>
</div>

## Tools

<div class="doc-property-list">
  <div><code>run_det_priors</code><span>Runs the deterministic phase — TSC, ESLint, npm audit with OSV, duplication, security lint, and context selection — and returns a paged bundle. The first call returns a review handle; later calls read the next page by handle and offset.</span></div>
  <div><code>lookup_type_def</code><span>Resolves a library export to its installed <code>.d.ts</code> declaration, so an API claim can cite the real signature.</span></div>
  <div><code>search_index</code><span>Planned. Semantic search over the local repo index.</span></div>
</div>

Every result is an envelope with three rules:

<div class="doc-property-list">
  <div><code>versioned</code><span>Each envelope carries a schema version, so a client upgrade cannot silently read the wrong shape.</span></div>
  <div><code>bounded</code><span>Each content block stays under 16 KiB. An oversized result returns a <code>result_too_large</code> envelope that tells the caller where to read instead. Citations are never truncated.</span></div>
  <div><code>degrading</code><span>A failure returns a structured not-found or error reason. It never throws across the transport, and one missing detector does not fail the review.</span></div>
</div>

## Run a lane

`warden opencode-review` drives the whole path. It checks the diff, starts OpenCode with the Warden MCP server, runs one lane, builds the trusted scope envelope, and publishes only the `CommentSet` from the post-pass. Warden itself needs no provider key on this path: the lane model is OpenCode's.

<div class="doc-code-card">
  <div class="doc-code-header"><span>One lane, published through the post-pass</span><code>OpenCode</code></div>
  <pre><code>warden opencode-review --base main
warden opencode-review --lane up --base main --json</code></pre>
</div>

<div class="doc-property-list">
  <div><code>--lane</code><span><code>down</code> (default) traces a claimed behavior through callers, state, and failure paths. <code>up</code> searches for structural drift and stays off unless you ask for it.</span></div>
  <div><code>--model</code><span>Override the lane model as <code>provider/model#variant</code>.</span></div>
  <div><code>--volume-cap</code><span>Maximum comments to emit. Default 5. Tier 1 is always kept.</span></div>
  <div><code>--lanes-out</code><span>Write the lane envelope JSON for audit, or to replay it through <code>warden post-pass</code>.</span></div>
  <div><code>--timeout</code><span>Stop the OpenCode child after N seconds. Default 900.</span></div>
</div>

Before the lane starts, a gate rejects a diff whose symlinks point outside the repository or into `.git`.

## Replay the post-pass

The post-pass is also a standalone command. It makes no model call. Feed it a saved lane envelope and a diff to get the same `CommentSet` again.

<div class="doc-code-card">
  <div class="doc-code-header"><span>Deterministic replay</span><code>no LLM</code></div>
  <pre><code>warden post-pass --lanes lanes.json --base main --json</code></pre>
</div>

<div class="doc-callout doc-callout-note">
  <strong>Status</strong>
  <p>This path is the direction set by ADR-0053. <code>warden review</code> still runs the original in-process boss loop and stays the default until the parity eval shows this path matches it on recall and precision.</p>
</div>
