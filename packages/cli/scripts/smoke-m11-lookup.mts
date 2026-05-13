/**
 * Smoke harness for M11's `lookupTypeDef` resolver (ADR-0026).
 *
 * Builds a synthetic `node_modules/` tree under tmpdir with several test
 * packages, then exercises the resolver against each scenario from the plan:
 *
 *   1. real symbol → found:true + well-formed `suggestedSource`
 *   2. missing package.json → found:false, reason: package_not_installed
 *   3. package with no `types`/`typings`/`exports` → no_types
 *   4. real package, unknown symbol → symbol_not_found
 *   5. re-exports via `export * from './sub'`
 *   6. namespace member (dotted path)
 *   7. subpath via `package.json#exports['./sub']`
 *   8. scoped + subpath (`@scope/pkg/internal`)
 *   9. direct-fallback subpath (no exports map)
 *  10. subpath cache independence (root vs `/sub` are separate rows)
 *
 * Cache invalidation: each smoke run uses a unique `version` per package
 * (PID-derived) so prior runs don't leave stale rows shadowing new fixtures.
 *
 * Usage: pnpm --filter @warden/cli smoke:m11-lookup
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m11-lookup-${process.pid}-${Date.now()}`);
const VERSION = `0.0.0-pid${process.pid}-${Date.now()}`;

function nm(packageName: string): string {
  return resolve(TMP_ROOT, "node_modules", packageName);
}

function writePkg(dir: string, pkgJson: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
}

function writeDts(absPath: string, content: string): void {
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, content);
}

if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

// 1. drizzle-orm-fake — root package with a `types` entry, exports
//    `withClause` (rename of the plan's `with` example since `with` is a
//    reserved keyword and not a valid top-level identifier).
{
  const dir = nm("drizzle-orm-fake");
  writePkg(dir, { name: "drizzle-orm-fake", version: VERSION, types: "./index.d.ts" });
  writeDts(
    resolve(dir, "index.d.ts"),
    [
      "/** Builds a JOIN clause. */",
      "export declare function withClause<T>(config: T): void;",
      "",
      "export declare class Builder {",
      "  /** Chained method. */",
      "  query<U>(sql: string, params?: readonly U[]): Promise<U[]>;",
      "}",
      "",
    ].join("\n"),
  );
}

// 3. pkg-without-types — package.json with no types/typings/exports fields.
{
  const dir = nm("pkg-without-types");
  writePkg(dir, { name: "pkg-without-types", version: VERSION, main: "./index.js" });
}

// 5. pkg-with-reexports — index.d.ts re-exports `X` from ./sub.
{
  const dir = nm("pkg-with-reexports");
  writePkg(dir, { name: "pkg-with-reexports", version: VERSION, types: "./index.d.ts" });
  writeDts(
    resolve(dir, "index.d.ts"),
    [
      "export * from './sub.js';",
      "",
    ].join("\n"),
  );
  writeDts(
    resolve(dir, "sub.d.ts"),
    [
      "export declare const X: number;",
      "export declare function helper(): string;",
      "",
    ].join("\n"),
  );
}

// 6. pkg-with-namespace — namespace member resolution via dotted path.
{
  const dir = nm("pkg-with-namespace");
  writePkg(dir, { name: "pkg-with-namespace", version: VERSION, types: "./index.d.ts" });
  writeDts(
    resolve(dir, "index.d.ts"),
    [
      "export declare namespace NS {",
      "  function foo(a: string): boolean;",
      "  const VALUE: number;",
      "}",
      "",
    ].join("\n"),
  );
}

// 7. pkg-with-subpath — subpath via `package.json#exports['./sub']`.
{
  const dir = nm("pkg-with-subpath");
  writePkg(dir, {
    name: "pkg-with-subpath",
    version: VERSION,
    types: "./index.d.ts",
    exports: {
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./sub": { types: "./sub-types.d.ts", default: "./sub.js" },
    },
  });
  writeDts(
    resolve(dir, "index.d.ts"),
    [
      "export declare function shared(): void;",
      "",
    ].join("\n"),
  );
  writeDts(
    resolve(dir, "sub-types.d.ts"),
    [
      "export declare function foo(): void;",
      "export declare function shared(): string; // distinct from root's `shared`",
      "",
    ].join("\n"),
  );
}

// 8. @scope/pkg — scoped, with /internal subpath.
{
  const dir = nm("@scope/pkg");
  writePkg(dir, {
    name: "@scope/pkg",
    version: VERSION,
    types: "./index.d.ts",
    exports: {
      ".": { types: "./index.d.ts" },
      "./internal": { types: "./internal.d.ts" },
    },
  });
  writeDts(
    resolve(dir, "index.d.ts"),
    [
      "export declare function top(): void;",
      "",
    ].join("\n"),
  );
  writeDts(
    resolve(dir, "internal.d.ts"),
    [
      "export declare function bar(): void;",
      "",
    ].join("\n"),
  );
}

// 9. pkg-no-exports — direct-fallback subpath (no `exports` map).
{
  const dir = nm("pkg-no-exports");
  writePkg(dir, {
    name: "pkg-no-exports",
    version: VERSION,
    main: "./index.js",
    types: "./index.d.ts",
  });
  writeDts(resolve(dir, "index.d.ts"), "export declare const ROOT: number;\n");
  writeDts(
    resolve(dir, "sub.d.ts"),
    [
      "export declare function baz(input: number): boolean;",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------

const { lookupTypeDef } = await import("@warden/core");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] lookupTypeDef — positive root lookup\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "drizzle-orm-fake", "withClause");
  assert(r.found === true, "drizzle-orm-fake#withClause resolves");
  if (r.found) {
    assert(
      /function withClause/.test(r.signature),
      `signature contains "function withClause": ${r.signature}`,
    );
    assert(r.kind === "function", `kind is "function" (got ${r.kind})`);
    assert(r.dts_file.endsWith("index.d.ts"), `dts_file points at index.d.ts: ${r.dts_file}`);
    assert(typeof r.line_start === "number" && r.line_start >= 1, `line_start >= 1 (${r.line_start})`);
    // suggestedSource shape.
    const ss = r.suggestedSource;
    assert(ss.type === "api_def", "suggestedSource.type === 'api_def'");
    assert(
      ss.id === `drizzle-orm-fake@${VERSION}#withClause`,
      `suggestedSource.id correct (${ss.id})`,
    );
    assert(ss.title === "function withClause", `suggestedSource.title correct (${ss.title})`);
    assert(ss.path === r.dts_file, "suggestedSource.path === dts_file");
    assert(ss.line === r.line_start, "suggestedSource.line === line_start");
    assert(ss.snippet === r.signature, "suggestedSource.snippet === signature");
    assert(
      !/\n/.test(ss.snippet),
      "suggestedSource.snippet is single-line normalized (no newlines)",
    );
  }
}

process.stdout.write(`\n[2] lookupTypeDef — package_not_installed\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "nonexistent-pkg", "foo");
  assert(r.found === false, "nonexistent-pkg is not found");
  if (!r.found) {
    assert(r.reason === "package_not_installed", `reason is package_not_installed (got ${r.reason})`);
  }
}

process.stdout.write(`\n[3] lookupTypeDef — no_types\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "pkg-without-types", "foo");
  assert(r.found === false, "pkg-without-types has no resolvable types");
  if (!r.found) {
    assert(r.reason === "no_types", `reason is no_types (got ${r.reason})`);
  }
}

process.stdout.write(`\n[4] lookupTypeDef — symbol_not_found\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "drizzle-orm-fake", "nonexistent_method");
  assert(r.found === false, "drizzle-orm-fake#nonexistent_method misses");
  if (!r.found) {
    assert(r.reason === "symbol_not_found", `reason is symbol_not_found (got ${r.reason})`);
  }
}

process.stdout.write(`\n[5] lookupTypeDef — re-exports\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "pkg-with-reexports", "X");
  assert(r.found === true, "pkg-with-reexports re-exports X via `export * from`");
  if (r.found) {
    assert(/\bX\b.*number/.test(r.signature), `signature mentions X (${r.signature})`);
    assert(r.kind === "variable", `kind is "variable" (got ${r.kind})`);
    assert(r.dts_file.endsWith("sub.d.ts"), `dts_file points at sub.d.ts: ${r.dts_file}`);
  }
}

process.stdout.write(`\n[6] lookupTypeDef — namespace member\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "pkg-with-namespace", "NS.foo");
  assert(r.found === true, "pkg-with-namespace#NS.foo resolves via dotted path");
  if (r.found) {
    assert(r.kind === "function", `NS.foo kind is "function" (got ${r.kind})`);
    assert(/foo\(/.test(r.signature), `signature contains foo(: ${r.signature}`);
  }
}

process.stdout.write(`\n[7] lookupTypeDef — subpath via exports['./sub']\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "pkg-with-subpath/sub", "foo");
  assert(r.found === true, "pkg-with-subpath/sub#foo resolves via exports map");
  if (r.found) {
    assert(
      r.dts_file.endsWith("sub-types.d.ts"),
      `dts_file points at sub-types.d.ts: ${r.dts_file}`,
    );
  }
}

process.stdout.write(`\n[8] lookupTypeDef — scoped + subpath\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "@scope/pkg/internal", "bar");
  assert(r.found === true, "@scope/pkg/internal#bar resolves");
  if (r.found) {
    assert(
      r.dts_file.endsWith("internal.d.ts"),
      `dts_file points at internal.d.ts: ${r.dts_file}`,
    );
  }
}

process.stdout.write(`\n[9] lookupTypeDef — direct-fallback subpath\n`);
{
  const r = await lookupTypeDef(TMP_ROOT, "pkg-no-exports/sub", "baz");
  assert(r.found === true, "pkg-no-exports/sub#baz resolves via direct sub.d.ts");
  if (r.found) {
    assert(r.dts_file.endsWith("sub.d.ts"), `dts_file points at sub.d.ts: ${r.dts_file}`);
  }
}

process.stdout.write(`\n[10] lookupTypeDef — subpath cache independence\n`);
{
  const rootR = await lookupTypeDef(TMP_ROOT, "pkg-with-subpath", "shared");
  const subR = await lookupTypeDef(TMP_ROOT, "pkg-with-subpath/sub", "shared");
  assert(rootR.found === true, "pkg-with-subpath#shared (root) resolves");
  assert(subR.found === true, "pkg-with-subpath/sub#shared resolves");
  if (rootR.found && subR.found) {
    assert(
      rootR.signature !== subR.signature,
      `root and subpath produce distinct signatures (root: ${rootR.signature} vs sub: ${subR.signature})`,
    );
    assert(
      rootR.dts_file !== subR.dts_file,
      `root and subpath cite different .d.ts files (${rootR.dts_file} vs ${subR.dts_file})`,
    );
  }
}

// Cleanup.
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
