/**
 * Shared I/O for the lane scripts (`materialize-lanes.mts`,
 * `measure-lanes.mts`) and `smoke-opencode-lanes.mts`: read a lane's
 * charter and every method source its includes list names. The
 * materializer stays pure; this module owns the disk reads.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseCharterIncludes,
  type LaneInclude,
  type LaneSpec,
  type MaterializeInput,
} from "../src/opencode/materialize.js";

export interface LaneInput extends MaterializeInput {
  /** The charter's includes list, in charter order. */
  includes: LaneInclude[];
}

/** Reads `spec.charterPath` and each included source file once, from `repoRoot`. */
export function readLaneInput(spec: LaneSpec, repoRoot: string): LaneInput {
  const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8");
  const charter = read(spec.charterPath);
  const includes = parseCharterIncludes(charter, spec.charterPath);
  const sources = new Map<string, string>();
  for (const include of includes) {
    if (!sources.has(include.file)) sources.set(include.file, read(include.file));
  }
  return { charter, sources, includes };
}
