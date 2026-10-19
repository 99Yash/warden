import { relative, sep } from "node:path";

/**
 * True for a repo-relative path that is out of every warden rule's scope: build
 * output, declaration and generated files, tests, mocks, evals, and anything
 * under a `scripts/` directory (smoke scripts, probes, repo tooling). Alfred's
 * rules read this predicate as `isSkippedPath` from its regex-rule table;
 * warden has no such table (docs/gate-design.md), so the predicate lives here.
 */
function isSkippedPath(file: string): boolean {
  return (
    /(^|\/)(dist|build|coverage|node_modules)\//.test(file) ||
    /\.(d|gen)\.ts$/.test(file) ||
    /\.test\.tsx?$/.test(file) ||
    /(^|\/)(test|__mocks__|evals)\//.test(file) ||
    file.endsWith(".eval.ts") ||
    /(^|\/)scripts\//.test(file)
  );
}

/**
 * True for `.ts`/`.tsx` source that {@link isSkippedPath} admits. A rule
 * returns this from `before()`, so its file scope needs no `overrides` entry
 * in `.oxlintrc.json`.
 */
export function inGateScope(filename: string, cwd: string): boolean {
  const file = repoFile(filename, cwd);

  return /\.tsx?$/.test(file) && !isSkippedPath(file);
}

/** The repo-relative `/`-separated path of the linted file, the form an owner list names. */
function repoFile(filename: string, cwd: string): string {
  return relative(cwd, filename).split(sep).join("/");
}
