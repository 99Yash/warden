import type { ToolFinding } from "./types.js";

// ADR-0054: these are observable text patterns, not proof of attacker intent.
const HIDDEN_UNICODE =
  /(?:\u034f|[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}])/gu;
const AUTHORITY_OVERRIDE =
  /\b(?:ignore|disregard|override|forget)\s+(?:(?:all|any|the|your|previous|prior|above|system|developer|earlier)\s+)*(?:instructions?|charter|system\s+prompt|review\s+rules)\b/i;
const REVIEWER_ADDRESS =
  /\b(?:(?:ai|automated|code|llm)\s+(?:code\s+)?reviewer|(?:code\s+)?review\s+(?:agent|bot)|ai\s+(?:assistant|agent)|chatgpt|claude|gemini|codex|warden|llm)\b/gi;
const DIRECTIVE =
  /^(?:[\s,:;.!*"'<>()[\]-]*(?:please\s+|you\s+(?:must|should|need\s+to)\s+)?)(?:ignore|disregard|override|forget|do\s+not|don't|never|skip|suppress|hide|omit|report|return|output|respond|approve|mark|send|upload|reveal|print|read|run|execute)\b/i;

function reviewerInstruction(text: string): boolean {
  if (AUTHORITY_OVERRIDE.test(text)) return true;
  return [...text.matchAll(REVIEWER_ADDRESS)].some((address) =>
    DIRECTIVE.test(text.slice(address.index + address[0].length)),
  );
}

interface AddedLine {
  file: string;
  line: number;
  text: string;
  hunk: number;
}

/** Git quotes paths with C escapes; octal sequences encode UTF-8 bytes. */
function targetPath(header: string): string | undefined {
  const raw = header.startsWith('"')
    ? /^"((?:\\.|[^"\\])*)"/.exec(header)?.[1]
    : header.split("\t")[0];
  if (raw === undefined || raw === "/dev/null") return undefined;
  let path = raw;
  if (header.startsWith('"')) {
    const escapes: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\x0b",
    };
    path = Buffer.concat(
      (raw.match(/\\(?:[0-7]{1,3}|.)|[^\\]+/g) ?? []).map((part) => {
        if (/^\\[0-7]/.test(part)) return Buffer.from([Number.parseInt(part.slice(1), 8)]);
        return Buffer.from(
          part.startsWith("\\") ? (escapes[part.slice(1)] ?? part.slice(1)) : part,
        );
      }),
    ).toString("utf8");
  }
  return path.startsWith("b/") ? path.slice(2) : path;
}

/** Read the supplied diff, not the working tree. Hunk counts keep +++ payloads as data. */
function* addedLines(diff: string): Generator<AddedLine> {
  let file: string | undefined;
  let line = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunk = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = undefined;
      oldRemaining = newRemaining = 0;
    } else if (oldRemaining > 0 || newRemaining > 0) {
      if (raw.startsWith("+") && newRemaining > 0) {
        if (file !== undefined) yield { file, line, text: raw.slice(1), hunk };
        line++;
        newRemaining--;
      } else if (raw.startsWith("-") && oldRemaining > 0) {
        oldRemaining--;
      } else if (raw.startsWith(" ")) {
        line++;
        oldRemaining = Math.max(0, oldRemaining - 1);
        newRemaining = Math.max(0, newRemaining - 1);
      }
    } else if (raw.startsWith("+++ ")) {
      file = targetPath(raw.slice(4));
    } else if (raw.startsWith("@@ ")) {
      const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (match) {
        oldRemaining = Number(match[1] ?? 1);
        line = Number(match[2]);
        newRemaining = Number(match[3] ?? 1);
        hunk++;
      }
    }
  }
}

/**
 * Two det-priors over ALL added lines, before noise pruning. Never quote
 * payloads in output: hidden text is named by code point, instructions by rule.
 * Publication re-runs this pure check outside model discretion.
 */
export function runInputIntegrity(diff: string): ToolFinding[] {
  const findings: ToolFinding[] = [];
  const lines = [...addedLines(diff)];
  const instructionLines = new Set<number>();
  function emit(added: AddedLine, ruleId: string, message: string, endLine = added.line) {
    findings.push({
      source: "input-integrity",
      file: added.file,
      line: added.line,
      endLine,
      column: 1,
      severity: "warning",
      ruleId,
      message,
    });
  }
  const instructionMessage =
    "Added text contains instructions addressed to an AI reviewer or an instruction to override its rules. Check this text before you trust the review result. This match does not prove malicious intent.";
  for (const [index, added] of lines.entries()) {
    const points = [
      ...new Set(
        [...added.text.matchAll(HIDDEN_UNICODE)].map(
          (match) => `U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
        ),
      ),
    ];
    if (points.length > 0)
      emit(
        added,
        "hidden-unicode",
        `Added text contains hidden Unicode (${points.join(", ")}). These characters can hide instructions or change the displayed text order. Check each character's purpose; some languages and emoji use these characters.`,
      );
    if (reviewerInstruction(added.text)) {
      instructionLines.add(index);
      emit(added, "reviewer-instruction", instructionMessage);
    }
  }
  // Small, contiguous windows catch an address or override split across comment
  // lines. Never combine removed/context lines, separate files, or hunks.
  for (let index = 0; index < lines.length; index++) {
    if (instructionLines.has(index)) continue;
    const first = lines[index]!;
    let text = first.text.replace(/^\s*(?:\/\/|\/\*|\*|#)\s*/, "");
    for (let size = 1; size < 3; size++) {
      const next = lines[index + size];
      if (
        !next ||
        instructionLines.has(index + size) ||
        next.hunk !== first.hunk ||
        next.file !== first.file ||
        next.line !== first.line + size
      )
        break;
      text += " " + next.text.replace(/^\s*(?:\/\/|\/\*|\*|#)\s*/, "");
      if (reviewerInstruction(text)) {
        emit(first, "reviewer-instruction", instructionMessage, next.line);
        for (let offset = 0; offset <= size; offset++) instructionLines.add(index + offset);
        break;
      }
    }
  }
  return findings;
}
