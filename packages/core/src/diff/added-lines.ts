export interface AddedLine {
  file: string;
  line: number;
  text: string;
  hunk: number;
}

/** Git quotes paths with C escapes; octal sequences encode UTF-8 bytes. */
export function decodeGitPath(header: string): string | undefined {
  const raw = header.startsWith('"')
    ? /^"((?:\\.|[^"\\])*)"/.exec(header)?.[1]
    : header.split("\t")[0];
  if (raw === undefined || raw === "/dev/null") return undefined;
  let path = raw;
  if (header.startsWith('"')) {
    const escapes = new Map([
      ["a", "\x07"],
      ["b", "\b"],
      ["f", "\f"],
      ["n", "\n"],
      ["r", "\r"],
      ["t", "\t"],
      ["v", "\x0b"],
    ]);
    path = Buffer.concat(
      (raw.match(/\\(?:[0-7]{1,3}|.)|[^\\]+/g) ?? []).map((part) => {
        if (/^\\[0-7]/.test(part)) return Buffer.from([Number.parseInt(part.slice(1), 8)]);
        return Buffer.from(
          part.startsWith("\\") ? (escapes.get(part.slice(1)) ?? part.slice(1)) : part,
        );
      }),
    ).toString("utf8");
  }
  return path;
}

/** Read the supplied diff, not the working tree. Hunk counts keep +++ payloads as data. */
export function* addedLines(diff: string): Generator<AddedLine> {
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
      const path = decodeGitPath(raw.slice(4));
      file = path?.startsWith("b/") ? path.slice(2) : path;
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
