#!/usr/bin/env node
// Recall hook for the repo lessons system (.lessons/).
// Modes:
//   session-start  -> inject the always-on lessons index
//   prompt         -> inject full lessons whose keywords match the user's prompt
//   pre-edit       -> inject full lessons whose globs match the file being edited
// Reads hook JSON from stdin (prompt/pre-edit), prints hookSpecificOutput JSON to
// stdout, and exits 0. Prints nothing when there is no match (no injection).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] || "session-start";
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LESSONS_DIR = join(ROOT, ".lessons");
const INDEX = join(LESSONS_DIR, "INDEX.md");

const EVENT =
  {
    "session-start": "SessionStart",
    prompt: "UserPromptSubmit",
    "pre-edit": "PreToolUse",
  }[mode] || "SessionStart";

function emit(text) {
  if (!text || !text.trim()) process.exit(0);
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: text } }),
  );
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function toArr(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}
function basename(p) {
  return p.split("/").pop();
}
function splitWords(s) {
  return s
    ? String(s)
        .toLowerCase()
        .replace(/[^a-z0-9.\-_]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3)
    : [];
}

function globMatch(glob, path) {
  if (!glob) return false;
  glob = String(glob);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  try {
    return new RegExp("^" + re + "$").test(path);
  } catch {
    return false;
  }
}

function listLessonFiles() {
  if (!existsSync(LESSONS_DIR)) return [];
  return readdirSync(LESSONS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md" && f !== "README.md")
    .map((f) => join(LESSONS_DIR, f));
}

function parseLesson(path) {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fmText = m ? m[1] : "";
  const body = (m ? m[2] : raw).trim();
  const fm = {};
  for (const line of fmText.split("\n")) {
    const mm = line.match(/^(\w+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      v = v
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, "");
    }
    fm[mm[1]] = v;
  }
  return { path, fm, body };
}

function renderLesson({ path, fm, body }) {
  return `## Lesson: ${fm.title || basename(path)}\n_(.lessons/${basename(path)})_\n\n${body}`;
}

// ---- session-start: inject the index -------------------------------------
if (mode === "session-start") {
  if (!existsSync(INDEX)) process.exit(0);
  const idx = readFileSync(INDEX, "utf8");
  if (!/^\s*-\s+\[/m.test(idx)) process.exit(0); // no lessons yet
  emit(
    `# Repo lessons (.lessons/)\n` +
      `Durable, hard-won lessons from past sessions. Before debugging or editing, check whether one applies and open its file for the full fix. \`/recall\` searches them, \`/learn\` adds one.\n\n` +
      idx.trim(),
  );
}

// ---- prompt: keyword match against the user's request ---------------------
if (mode === "prompt") {
  let input = {};
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {}
  const prompt = (input.prompt || "").toLowerCase();
  if (!prompt) process.exit(0);
  const words = new Set(
    prompt
      .replace(/[^a-z0-9.\-_/]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
  const scored = [];
  for (const f of listLessonFiles()) {
    const lesson = parseLesson(f);
    const terms = [
      ...toArr(lesson.fm.keywords),
      ...toArr(lesson.fm.globs),
      ...splitWords(lesson.fm.title),
      ...splitWords(lesson.fm.symptom),
    ]
      .map((t) => String(t).toLowerCase())
      .filter(Boolean);
    const hit = new Set();
    for (const t of terms) {
      for (const w of words) {
        if (t === w || t.includes(w) || w.includes(t)) hit.add(t);
      }
    }
    if (hit.size >= 2) scored.push({ lesson, score: hit.size });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  if (!top.length) process.exit(0);
  emit(
    `# Possibly relevant repo lessons\nPast lessons that may apply to this request — check before proceeding:\n\n` +
      top.map(({ lesson }) => renderLesson(lesson)).join("\n\n---\n\n"),
  );
}

// ---- pre-edit: glob match against the file being edited -------------------
if (mode === "pre-edit") {
  let input = {};
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {}
  const fp = (input.tool_input && input.tool_input.file_path) || "";
  if (!fp) process.exit(0);
  const rel = fp.startsWith(ROOT) ? fp.slice(ROOT.length + 1) : fp;
  const base = basename(rel);
  const matches = [];
  for (const f of listLessonFiles()) {
    const lesson = parseLesson(f);
    const globs = toArr(lesson.fm.globs);
    if (globs.some((g) => globMatch(g, rel) || globMatch(g, base))) matches.push(lesson);
  }
  if (!matches.length) process.exit(0);
  emit(
    `# Repo lesson for ${rel}\nA past lesson covers files like this — apply it:\n\n` +
      matches.slice(0, 3).map(renderLesson).join("\n\n---\n\n"),
  );
}
