---
name: handoff
description: Write a chronological handoff doc to .handoff/ capturing findings, evidence, current state and next steps so work can continue in a fresh context window — then distill any durable lessons into .lessons/. Use at session end or when the user says /handoff.
user-invokable: true
args:
  - name: focus
    description: Optional focus / what the handoff is about. If omitted, infer from the session.
    required: false
---

Produce a handoff doc so a fresh context window can resume this work, then distill the durable lessons so the next session doesn't relearn them.

The handoff is **raw ore** (verbose, chronological, ephemeral). The lessons are the **refined metal** (terse, durable, indexed). Both come out of this command.

## Part 1 — Write the handoff doc

1. Get the timestamp: run `date -u +%Y-%m-%dT%H%M%SZ`.

2. Write `.handoff/<timestamp>.md` capturing the **chronological progression** of this session, with these sections:

   - **Goal** — what we set out to do.
   - **Progression** — what was tried, in order, with the evidence: commands run, errors hit, what worked and what didn't. This is the part that prevents the next window from re-walking dead ends — keep the evidence (stack traces, key output, file:line refs).
   - **Current state** — what's true right now: what's done, what's in flight, what's broken, branch/uncommitted changes.
   - **Next steps** — the concrete next actions to resume.
   - **Open questions** — anything unresolved or needing a decision.

   Verbose is fine here — this file is disposable and is NOT loaded into future sessions automatically. To resume, the user `@`-mentions or pastes it into the new window.

## Part 2 — Distill the lessons (the part that compounds)

This is the reliable capture trigger: the cost was just paid and the evidence is all above.

3. Review the progression and ask: **what 1–3 things, had we known them at the start, would have saved this session?**

4. For each that clears the `/learn` bar (non-obvious AND costly AND repeatable), capture it following the **`/learn` capture format** — dedup against `.lessons/INDEX.md` first (update an existing lesson rather than duplicating), write `.lessons/<slug>.md`, and add its one-line hook to the index. Do not let verbose handoff content leak into a lesson or the index — distill it down.

   If nothing clears the bar, say so — not every session yields a durable lesson.

5. Report: the handoff path, and which lessons were written/updated (or that none qualified).
