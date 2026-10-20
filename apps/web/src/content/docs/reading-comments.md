---
title: Reading a comment
description: What each part of a Warden comment means, including tiers, categories, kinds, and sources, and what the notes about skipped work are telling you.
---

<p class="doc-lede">Every Warden comment answers the same questions: how much this matters, what kind of problem it is, how sure Warden is, and what it rests on. Here's how to read the answers.</p>

## The shape of a comment

This is an illustrative comment in the shape Warden emits. It isn't output from a real run.

```json
{
  "id": "W-27e09cfd5d",
  "file": "src/jobs/retry.ts",
  "lineStart": 42,
  "lineEnd": 47,
  "tier": 2,
  "category": "correctness",
  "kind": "question",
  "confidence": 0.62,
  "claim": "Can a failed attempt be retried after the job is marked complete?",
  "explanation": "markComplete() runs before the retry check, and the guard in scheduleRetry() reads the status only once …",
  "suggestedAction": "Check the status inside scheduleRetry(), or mark the job complete after the retry decision.",
  "sources": [
    {
      "type": "repo_convention",
      "path": "src/jobs/retry.ts",
      "line": 44,
      "snippet": "await markComplete(job.id);"
    }
  ]
}
```

The `id` comes from the comment's content, so the same finding gets the same ID on every run. That lets a bot recognize a comment it has already posted.

## Tiers: how much it matters

<div class="doc-tier-grid">
  <div class="doc-tier tier-one"><span>Tier 1</span><strong>Block</strong><p>Fix before merging. Always published, even past the volume cap.</p></div>
  <div class="doc-tier tier-two"><span>Tier 2</span><strong>Fix</strong><p>A real problem or risk. Usually worth fixing in this change.</p></div>
  <div class="doc-tier tier-three"><span>Tier 3</span><strong>Consider</strong><p>Style, cleanup, or duplication. Hidden in reviews unless you pass <code>--verbose</code>.</p></div>
</div>

## Kinds: a claim or a question

A comment is either an **assertion** ("this breaks") or a **question** ("can this break?"). Warden's checks decide which, not the model. When a finding's confidence is below the bar (0.7 in general, 0.8 for security), an assertion becomes a question.

Questions aren't a weaker sort of comment. Often the reviewer can see that something is odd but can't see the intent behind it: whether a branch is meant to be unreachable, or whether a field is meant to be optional. A question gives you the observation without pretending to know the answer. If the answer is "yes, on purpose", you've lost ten seconds, not your trust in the tool.

## Categories: what to read first

Comments are sorted by category, in the order a careful reviewer would read a change:

<div class="doc-priority-chain" aria-label="Category reading order">
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
  <span>leverage</span>
  <span>dedup</span>
  <span>tests</span>
</div>

This is reading order, not severity, and it's a separate scale from the tier. A Tier 2 correctness comment comes before a Tier 1 style comment, because fixing a correctness bug can change the code the other comments are about. `leverage` means a library or standard-library feature could replace hand-written code, and it comes just before `dedup` because a good replacement can remove the duplication altogether.

A few categories may be unfamiliar:

- **`contract`**: the change breaks something callers rely on, such as a signature, a return shape, or a documented behavior.
- **`committability`**: something that shouldn't be committed at all, such as a leftover `debugger`, a stray `console.log`, or a local path.
- **`consistency`**: the change disagrees with the code around it, such as a docstring that no longer matches the function.

## Sources: what it rests on

A comment can quote the code it's about, cite an outside authority, or both. Each kind of source is checked in its own way:

<div class="doc-property-list">
  <div><code>tool</code><span>Output from a deterministic tool: TypeScript, ESLint, <code>jscpd</code>, <code>npm audit</code>, or one of Warden's detectors. The tool's result is the grounding.</span></div>
  <div><code>advisory, cve</code><span>A vulnerability record, confirmed against OSV.dev. Without an OSV record, the comment is dropped.</span></div>
  <div><code>api_def</code><span>A library declaration from the <code>.d.ts</code> file installed in <code>node_modules</code>, found with <code>lookup_type_def</code>. This is the only source that counts as authority for a claim about how a library behaves.</span></div>
  <div><code>repo_convention</code><span>The repository itself: the code under review, or an existing pattern the change departs from.</span></div>
  <div><code>documentation, changelog, web</code><span>An outside reference with a URL.</span></div>
</div>

Any source that quotes a file, with a path, a line, and a snippet, is checked against that file near the cited line. If none of a comment's quotes match, the comment is dropped.

What a matching quote proves is limited, and it's worth being clear about it. It proves the code exists. It doesn't prove the reasoning about that code is right. Warden's own early runs passed every citation check and were still wrong two times out of three ([the story](/docs/principles/#a-quote-proves-the-code-exists-not-that-the-argument-holds)). That's why many comments are reasoned judgments with a quote attached, not facts with an authority behind them, and why the uncertain ones are phrased as questions.

## Notes about what didn't run

Next to the comments, every result carries a `degradedWorkers` list. Each note says what didn't run, what was skipped, or what was dropped:

```json
{
  "degradedWorkers": [
    {
      "kind": "actionable",
      "topic": "noise-filter",
      "message": "Skipped generated subtree before runner dispatch."
    }
  ]
}
```

- **`actionable`** notes show in the normal output. They mean you can do something about it, or that the result isn't clean: a lane failed, the diff was empty, or the secret guard dropped a finding.
- **`warning`** notes mean part of the review failed but the rest is still useful. They show with `--verbose` or in JSON.
- **`info`** notes are forensic detail. They never block anything.

These notes exist because a narrower review that says it's narrower is safer than one that quietly skips work. If Warden couldn't check something, you should hear about it from Warden.
