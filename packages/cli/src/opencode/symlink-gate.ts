import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { errnoCode } from "@warden/core/guards";

/** Decode Git's C-quoted paths, including octal UTF-8 bytes. */
function gitPath(value: string): string {
  if (!value.startsWith('"')) return value.replace(/\t$/, "");
  const bytes: number[] = [];
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  const body = value.slice(1, value.lastIndexOf('"'));
  for (let i = 0; i < body.length; i++) {
    let ch = body.charAt(i);
    if (ch === "\\") {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
      if (octal !== null) {
        bytes.push(Number.parseInt(octal[0], 8));
        i += octal[0].length;
        continue;
      }
      i += 1;
      // Git never ends a quoted path with a lone backslash. Fail closed, as
      // the gate does for every path it cannot read.
      if (i >= body.length) throw new Error(`malformed quoted path in the diff: ${value}`);
      const escaped = body.charAt(i);
      ch = escapes[escaped] ?? escaped;
    }
    bytes.push(...Buffer.from(ch));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** New-side paths, including pure renames; deleted links cannot be read. */
function changedPaths(diff: string): Array<{ path: string; symlink: boolean }> {
  const paths: Array<{ path: string; symlink: boolean }> = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    let path: string | undefined;
    let symlink = false;
    let deleted = false;
    // Only inspect headers. Added file content can look like a diff header.
    for (const line of block.split("\n").slice(1)) {
      if (line.startsWith("@@")) break;
      if (line === "deleted file mode 120000" || line === "+++ /dev/null") deleted = true;
      if (
        /^(?:new file mode|new mode) 120000$/.test(line) ||
        /^index \w+\.\.\w+ 120000$/.test(line)
      ) {
        symlink = true;
      }
      if (line.startsWith("+++ ")) path = gitPath(line.slice(4)).replace(/^b\//, "");
      if (line.startsWith("rename to ")) path = gitPath(line.slice(10));
      if (line.startsWith("copy to ")) path = gitPath(line.slice(8));
    }
    if (path !== undefined && !deleted) paths.push({ path, symlink });
  }
  return paths;
}

function isGitMetadata(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git");
}

function isOutside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Resolve existing ancestors too, so a dangling target cannot hide behind a directory link. */
function canonicalTarget(path: string, seen = new Set<string>()): string {
  if (seen.has(path)) throw new Error("cyclic link");
  seen.add(path);
  try {
    return realpathSync(path);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return canonicalTarget(resolve(dirname(path), readlinkSync(path)), seen);
      }
    } catch (statError) {
      if (errnoCode(statError) !== "ENOENT") throw statError;
    }
    const parent = dirname(path);
    if (parent === path) throw err;
    return resolve(canonicalTarget(parent, seen), relative(parent, path));
  }
}

/**
 * ADR-0054 §2(g): fail before OpenCode starts if a changed symlink points
 * outside the repo or into Git metadata. The checkout supplies the target;
 * mode 120000 in the diff makes a missing/replaced link fail closed. Check
 * existing chains as well as lexical paths, without reading target contents.
 * This is a preflight check, not protection against concurrent filesystem changes.
 */
export function laneSymlinkGate(diff: string, repoRoot: string): string | undefined {
  const root = realpathSync(repoRoot);
  const rejected = new Set<string>();
  for (const { path, symlink } of changedPaths(diff)) {
    const link = resolve(repoRoot, path);
    let mustCheck = symlink;
    try {
      if (isOutside(resolve(repoRoot), link)) throw new Error("outside path");
      if (!lstatSync(link).isSymbolicLink()) {
        if (symlink) rejected.add(path);
        continue;
      }
      mustCheck = true;
      const target = resolve(dirname(link), readlinkSync(link));
      const canonical = canonicalTarget(target);
      if (isGitMetadata(target) || isGitMetadata(canonical) || isOutside(root, canonical)) {
        rejected.add(path);
      }
    } catch (err) {
      // A deleted regular file has no target to check. A declared symlink
      // or an unreadable existing path must not silently bypass the gate.
      if (mustCheck || errnoCode(err) !== "ENOENT") {
        rejected.add(path);
      }
    }
  }
  if (rejected.size === 0) return undefined;
  return `unsafe symlink: this diff changes ${[...rejected]
    .sort()
    .map((path) => JSON.stringify(path))
    .join(
      ", ",
    )}; the target is outside the repo, in .git, or cannot be checked; the lane does not run (ADR-0054 §2(g))`;
}
