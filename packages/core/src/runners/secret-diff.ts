import { addedLines, decodeGitPath } from "../diff/added-lines.js";
import { CREDENTIAL_RULES, isSecretFilePath, matchCredential } from "../secret-guard.js";
import type { ToolFinding } from "./types.js";

/**
 * ADR-0054 §8: report credential shapes and sensitive files directly from
 * the diff. Credential formats require added lines. Never copy values,
 * snippets, or model-owned prose.
 * A path match reports a sensitive file, not proof that it holds a secret.
 */
export function runSecretDiff(diff: string): ToolFinding[] {
  const findings: ToolFinding[] = [];
  const reportedFiles = new Set<string>();
  const emit = (file: string, line: number, ruleId: string, message: string) =>
    findings.push({
      source: "secret-diff",
      file,
      line,
      column: 1,
      severity: "warning",
      ruleId,
      message,
    });
  const fileMessage =
    "The diff changes a sensitive file. Check whether this file should be committed. The path does not prove that the file contains a credential.";
  for (const added of addedLines(diff)) {
    // A filename can itself hold a credential. Do not publish such an anchor.
    if (matchCredential(added.file) !== undefined) continue;
    if (isSecretFilePath(added.file) && !reportedFiles.has(added.file)) {
      emit(added.file, added.line, "sensitive-file-in-diff", fileMessage);
      reportedFiles.add(added.file);
    }
    for (const rule of CREDENTIAL_RULES) {
      if (rule.pattern.test(added.text)) {
        emit(
          added.file,
          added.line,
          rule.id,
          `Added text matches a hardcoded credential format (rule ${rule.id}). Remove the value and replace any live credential. This format match does not prove that the credential is active.`,
        );
      }
    }
  }
  // Empty additions, binary changes, and pure renames have no added line.
  // Use the existing 0:0 file-level anchor rather than inventing line 1.
  for (const file of changedTargets(diff)) {
    if (!reportedFiles.has(file) && isSecretFilePath(file) && matchCredential(file) === undefined) {
      emit(file, 0, "sensitive-file-in-diff", fileMessage);
      reportedFiles.add(file);
    }
  }
  return findings;
}

/** Canonical Git headers are separate from hunk payload, which has a line prefix. */
function changedTargets(diff: string): string[] {
  const paths = new Set<string>();
  let target: string | undefined;
  let deleted = false;
  const finish = () => {
    if (target !== undefined && !deleted) paths.add(target);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      deleted = false;
      // Git does not quote ordinary spaces, including a literal " b/" in
      // a filename. Require equal old/new paths for same-path headers;
      // differing rename/copy targets come from their explicit metadata.
      const samePath = /^diff --git a\/(.+) b\/\1$/.exec(line);
      const quoted = /^diff --git ("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/.exec(line);
      const oldPath = quoted === null ? undefined : decodeGitPath(quoted[1]!)?.slice(2);
      const newPath = quoted === null ? undefined : decodeGitPath(quoted[2]!)?.slice(2);
      target = samePath?.[1] ?? (oldPath === newPath ? newPath : undefined);
    } else if (line.startsWith("deleted file mode ")) {
      deleted = true;
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      target = decodeGitPath(line.slice(line.indexOf(" to ") + 4));
    }
  }
  finish();
  return [...paths];
}
