---
title: Introduction
description: What Warden is, the problem it exists to solve, and how the work splits between Warden and your agent runtime.
---

<p class="doc-lede">Warden is a code reviewer that has to show its work. It runs the checks that produce facts, hands those facts to the agent doing the review, and then checks the agent's findings before any of them reach you.</p>

## The problem

A review comment is an interruption. It asks you to stop, reread your own change, and decide whether you got it wrong. When a colleague leaves one, you have a decent sense of how much to trust it. When a model leaves one, you don't, and the model sounds just as sure when it's wrong as when it's right.

We found out how quickly that goes bad by running Warden on our own pull requests. On one 119-file PR it left twelve findings, and eight of them were wrong. All eight quoted real code, so all eight looked grounded. Four pointed at lines the PR hadn't touched. The other four were contradicted by code the reviewer never opened: a guard in the function being called, a caller that already lowercased its input. A reviewer like that teaches you to skim past it, and then the real bug goes by with the rest.

So the question behind Warden isn't "how do we get the model to say more?" It's "what has to be true before a model's comment deserves your attention?"

## What Warden does

<figure class="doc-flow" aria-label="How a Warden review is split">
  <div class="doc-flow-step">
    <span class="doc-flow-owner">Warden</span>
    <strong>Gather evidence</strong>
    <p>Type checks, lint, audited advisories, detectors, and scans of the added lines. No model involved.</p>
  </div>
  <div class="doc-flow-step doc-flow-step-runtime">
    <span class="doc-flow-owner">Your runtime</span>
    <strong>Review</strong>
    <p>A review agent reads the code and calls Warden over MCP for the evidence and real type definitions.</p>
  </div>
  <div class="doc-flow-step">
    <span class="doc-flow-owner">Warden</span>
    <strong>Check, then publish</strong>
    <p>Citations, scope, secrets, confidence, and volume are checked outside the model.</p>
  </div>
</figure>

**Before the model starts,** Warden runs the tools that can't make things up: TypeScript, your ESLint config, `npm audit` with every advisory confirmed against [OSV.dev](https://osv.dev), duplication detection, Warden's own detectors for scalability, dead code, consistency, and simpler library or standard-library replacements, plus security lint. It also scans the lines the PR adds for credentials, hidden Unicode, and text that tries to give the reviewer instructions.

**During the review,** the work happens in your agent runtime. [OpenCode](https://opencode.ai) is the first one we support. Warden runs as an [MCP](https://modelcontextprotocol.io) server, and the review agent calls it for the deterministic results and for the installed type declarations of any library it wants to make a claim about.

**After the agent finishes,** Warden checks every finding before anything is published. Each quoted snippet has to match the file it cites. A finding has to sit on a line the PR added, inside the files the agent was asked to review. A finding that would repeat a credential is dropped, and the output says so. A claim the agent wasn't sure about becomes a question. And you get five comments at most, unless more of them are blocking.

That last step is the reason the rest is worth doing. Because it runs after the model and outside it, the model can't skip it, talk its way past it, or forget to call it.

## Why the review runs somewhere else

Warden used to run its own review loop: an Opus "boss" that read the diff and sent work to cheaper worker models. Most of our bugs lived in that loop. On a fixture with bugs planted in it, the boss sometimes dispatched no workers at all and returned zero comments. A stronger prompt made it worse. A model upgrade broke structured output. And once, a provider's strict schema mode quietly failed every worker call, so the loop reported "no findings", exited cleanly, and looked like a cheap, successful run.

Every one of those fixes was real work, and none of it touched the part of Warden that's hard to build. Agent runtimes already handle the loop well (subagents, per-agent models, permissions, sessions), and they get better with every release. What they don't come with is a detector corpus, verified advisories, an index of your repository, or an eval harness that measures whether reviews are any good.

So we split the job ([ADR-0053](https://github.com/99Yash/warden/blob/main/decisions.md)). Warden keeps the method and the checks, and the runtime runs the loop. They talk over MCP, so OpenCode is the first runtime, not the only possible one.

The longer version, including the mistakes that got us here, is in [Why Warden works this way](/docs/principles/).

## Where things stand

As of October 2026:

- `warden opencode-review` runs one review lane in OpenCode and publishes only what passes Warden's checks. The `down` lane, which tries to break the behavior a change claims, is the default. The `up` lane, which looks for structural problems, is opt-in.
- `warden review`, the original in-process loop, is still the default review command. It gets replaced once the parity eval ([#43](https://github.com/99Yash/warden/issues/43)) shows the new path matches it on recall and precision. That eval hasn't had a gating run yet.
- The CI workflow is a trial. It writes to the job summary, doesn't comment on the pull request, and has no spend cap yet.
- Warden isn't published to npm. You run it from a clone of the repository.

## Next steps

- [Install](/docs/install/) Warden and run the deterministic check on your repository.
- [Connect OpenCode](/docs/mcp/) and run your first review lane.
- Read [how a review runs](/docs/review/), step by step.
- Learn to [read a comment](/docs/reading-comments/): tiers, categories, and sources.
