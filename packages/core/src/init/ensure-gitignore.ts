import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Idempotent `.gitignore` helper (ADR-0019 #12). Adds `.warden/` to the
 * repo's `.gitignore` so the local cache file never leaks into commits.
 * Called from `init`, `review`, and `check`; surfaces in `degradedWorkers`
 * exactly once — on the run that actually appended.
 *
 * Lives in `@warden/core` because it's deterministic file I/O at a known
 * path (the repo root), not stdout/argv-shaped I/O. Same posture as the
 * import-graph cache writes in M5.
 */

const WARDEN_LINE = ".warden/";
const WARDEN_HEADER = "# warden";

export interface EnsureGitignoreResult {
  added: boolean;
}

export async function ensureGitignore(repoRoot: string): Promise<EnsureGitignoreResult> {
  const path = resolve(repoRoot, ".gitignore");
  const existing = await tryRead(path);

  if (existing === null) {
    await writeFile(path, `${WARDEN_HEADER}\n${WARDEN_LINE}\n`, "utf8");
    return { added: true };
  }

  if (containsWardenEntry(existing)) {
    return { added: false };
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const block = `${needsLeadingNewline ? "\n" : ""}\n${WARDEN_HEADER}\n${WARDEN_LINE}\n`;
  await writeFile(path, existing + block, "utf8");
  return { added: true };
}

function containsWardenEntry(content: string): boolean {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === ".warden" || line === ".warden/") return true;
  }
  return false;
}

async function tryRead(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
