import { dirname } from "node:path";
import { SAME_FOLDER_CAP } from "../index.js";

/**
 * Same-folder siblings signal (ADR-0018). Path-only — content is not
 * surfaced because folders are noisy. The signal is high-recall, low-
 * precision; treating it as awareness-only avoids polluting the prompt
 * window with unrelated files in a 50-file `auth/` folder.
 */
export function collectSameFolderReasons(
  changedRel: string[],
  allFilesByDir: Map<string, string[]>,
): Map<string, Array<{ sibling: string }>> {
  const out = new Map<string, Array<{ sibling: string }>>();
  const changedSet = new Set(changedRel);

  for (const change of changedRel) {
    const dir = dirname(change);
    const siblings = allFilesByDir.get(dir);
    if (!siblings) continue;
    let count = 0;
    for (const sib of siblings) {
      if (changedSet.has(sib)) continue;
      if (count >= SAME_FOLDER_CAP) break;
      let bucket = out.get(sib);
      if (!bucket) {
        bucket = [];
        out.set(sib, bucket);
      }
      bucket.push({ sibling: change });
      count++;
    }
  }

  return out;
}

export function buildFilesByDir(allFilesRel: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of allFilesRel) {
    const dir = dirname(f);
    let bucket = map.get(dir);
    if (!bucket) {
      bucket = [];
      map.set(dir, bucket);
    }
    bucket.push(f);
  }
  return map;
}
