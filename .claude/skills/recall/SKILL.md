---
name: recall
description: Search past repo lessons in .lessons/ for ones relevant to a topic or the current task and surface their fixes. Use when stuck, before debugging something unfamiliar, or when the user says /recall.
user-invokable: true
args:
  - name: topic
    description: What to search for. If omitted, use the current task / error in context.
    required: false
---

Find and surface relevant durable lessons from `.lessons/`.

You are the retriever — the index is small enough to read in full, so use judgment, not just substring grep.

## Steps

1. **Read `.lessons/INDEX.md`.** If it has no lessons, say so and stop.

2. **Select semantically.** Match the topic (from args, or the current error/task in context) against the index lines by meaning, not just exact words — "expo bundler error" should match a lesson about metro cache. Pick the lessons that plausibly apply.

3. **Open the matched files** in `.lessons/` and read the full `Fix`/`Why`.

4. **Report** each relevant lesson concisely: its title, the fix, and the file path (`.lessons/<slug>.md`) so the user can open it. If two lessons compete, surface both. If nothing genuinely matches, say so plainly — don't force a stretch.

5. If the current work reveals one of the lessons is now **stale or wrong**, point it out and offer to update it via `/learn`.
