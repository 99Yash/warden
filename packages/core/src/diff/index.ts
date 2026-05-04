export interface ChangedFile {
  path: string;
  addedLines: number[];
}

export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files = new Map<string, Set<number>>();
  let currentPath: string | undefined;
  let newLineNo = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        currentPath = undefined;
        continue;
      }
      currentPath = target.startsWith("b/") ? target.slice(2) : target;
      if (!files.has(currentPath)) files.set(currentPath, new Set());
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("diff --git ") || line.startsWith("index ")) continue;
    if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) newLineNo = Number.parseInt(m[1] ?? "0", 10);
      continue;
    }
    if (!currentPath) continue;
    if (line.startsWith("+")) {
      files.get(currentPath)?.add(newLineNo);
      newLineNo++;
    } else if (line.startsWith("-")) {
      // removed line — does not advance new-side counter
    } else if (line.startsWith(" ") || line === "") {
      newLineNo++;
    }
  }

  return Array.from(files, ([path, addedLines]) => ({
    path,
    addedLines: Array.from(addedLines).sort((a, b) => a - b),
  }));
}
