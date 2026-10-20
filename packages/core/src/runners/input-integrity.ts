import { addedLines, type AddedLine } from "../diff/added-lines.js";
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
        [...added.text.matchAll(HIDDEN_UNICODE)].map((match) => {
          // HIDDEN_UNICODE matches exactly one code point, never an empty string.
          const point = match[0].codePointAt(0);
          if (point === undefined) throw new Error("HIDDEN_UNICODE matched an empty string");
          return `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
        }),
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
  for (const [index, first] of lines.entries()) {
    if (instructionLines.has(index)) continue;
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
