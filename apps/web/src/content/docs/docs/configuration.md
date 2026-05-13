---
title: Configuration
description: Environment variables used by Warden.
---

<p class="doc-lede">Warden reads environment variables through <code>@warden/env</code>. Application code should not read <code>process.env</code> directly, because validation and defaults live in one package.</p>

<div class="doc-property-list doc-env-list">
  <div>
    <code>ANTHROPIC_API_KEY</code>
    <span><b>Required.</b> Primary LLM provider for <code>warden review</code>.</span>
  </div>
  <div>
    <code>VOYAGE_API_KEY</code>
    <span><b>Required for init.</b> Enables the Voyage <code>voyage-code-3</code> embedding-backed context index.</span>
  </div>
  <div>
    <code>GOOGLE_GENERATIVE_AI_API_KEY</code>
    <span><b>Optional.</b> Enables Anthropic → retry → Google fallback when the primary provider fails transiently.</span>
  </div>
  <div>
    <code>WARDEN_THINKING_BUDGET</code>
    <span><b>Optional.</b> Anthropic extended-thinking budget in tokens. Defaults to <code>4096</code>.</span>
  </div>
  <div>
    <code>WARDEN_LOG_LEVEL</code>
    <span><b>Optional.</b> Controls log verbosity: <code>silent</code>, <code>error</code>, <code>warn</code>, <code>info</code>, or <code>debug</code>.</span>
  </div>
</div>

<div class="doc-callout doc-callout-warning">
  <strong>When adding a variable</strong>
  <p>Update <code>packages/env/src/index.ts</code>, <code>.env.example</code>, and the documentation together so runtime validation and user-facing setup stay aligned.</p>
</div>

## Cache location

<div class="doc-code-card">
  <div class="doc-code-header"><span>Local cache</span><code>gitignored</code></div>
  <pre><code>.warden/cache.sqlite</code></pre>
  <p>The SQLite file stores chunks, embeddings, Merkle state, import graph cache, file state, and LLM review cache records. Delete it when you need a clean rebuild; <code>warden init</code> recreates it.</p>
</div>

<div class="doc-callout doc-callout-note">
  <strong>Local-first boundary</strong>
  <p>Source code and cache files stay on your machine. Network calls happen only for configured providers: Voyage embeddings, Anthropic or Google review formatting, and OSV vulnerability verification.</p>
</div>
