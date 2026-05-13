import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import ts from "typescript";
import { and, db, eq, typeDefCache } from "@warden/db";

/**
 * `lookupTypeDef` — M11 (ADR-0026) `.d.ts` resolver.
 *
 * Pure function: given `(repoRoot, package, symbol)`, walks
 * `node_modules/<package>/` to resolve a `.d.ts` file, parses it, and
 * returns the type definition for `symbol` as a discriminated union. The
 * caller (the AI SDK tool descriptor) wraps this in a `tool({ inputSchema,
 * execute })` for the formatter LLM to invoke.
 *
 * Direct `typescript` import is deliberate. The selector-side rule in
 * `context/parser.ts` ("only this file imports `typescript`") is scoped to
 * *selector signal files* — the M5/M6 context-selection layer. M11 needs
 * a different surface (full top-level + namespace + class-member symbol
 * walking, JSDoc capture, re-export following across `.d.ts` files); the
 * `TsCompilerParser.imports()/exports()` shape doesn't fit. Keeping the
 * resolver self-contained is cleaner than extending `SourceParser` with a
 * domain-specific method the selectors don't use.
 *
 * Results — both positive and negative — are cached in the `type_def_cache`
 * SQLite table. Cache key is `(package, version, symbol)` where `package`
 * is the *literal* import path (subpaths included) and `version` is the
 * installed version of the root package. `npm install` flipping the version
 * naturally invalidates cached rows (queries filter on the *current*
 * version). The single exception is `package_not_installed` — never cached
 * because the version is unknown.
 */

export type TypeDefKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "namespace"
  | "method"
  | "property"
  | "enum";

export type NotFoundReason =
  | "package_not_installed"
  | "no_types"
  | "symbol_not_found"
  | "lookup_error";

/**
 * Pre-shaped `Source` object the LLM copies verbatim into `Comment.sources[]`.
 * Eliminates a class of LLM-reconstruction failure modes (see ADR-0026 §11):
 *   - `SourceSchema`'s all-or-nothing refinement rejects partial triples.
 *   - Manual `id` / `title` formatting drifts under prompt pressure.
 *   - `path` / `line` / `snippet` field-name confusion.
 * The resolver constructs this object; the LLM does not assemble fields.
 */
export interface SuggestedApiDefSource {
  type: "api_def";
  id: string;
  title: string;
  path: string;
  line: number;
  snippet: string;
  retrievedAt: string;
}

export type LookupTypeDefResult =
  | {
      found: true;
      package: string;
      version: string;
      symbol: string;
      signature: string;
      kind: TypeDefKind;
      jsdoc: string | null;
      dts_file: string;
      line_start: number;
      line_end: number;
      suggestedSource: SuggestedApiDefSource;
    }
  | {
      found: false;
      package: string;
      symbol: string;
      reason: NotFoundReason;
    };

/** Cap on `export * from './sub'` re-export recursion. ADR-0026 §12. */
const REEXPORT_DEPTH_CAP = 8;

interface SymbolEntry {
  kind: TypeDefKind;
  signature: string;
  jsdoc: string | null;
  /** Absolute path to the .d.ts file the symbol actually lives in. May
   * differ from the entrypoint file when resolution followed re-exports. */
  dtsAbsPath: string;
  line_start: number;
  line_end: number;
}

type SymbolTable = Map<string, SymbolEntry>;

export async function lookupTypeDef(
  repoRoot: string,
  pkg: string,
  symbol: string,
): Promise<LookupTypeDefResult> {
  // 1. Split into (packageName, subpath).
  const split = splitImportPath(pkg);
  if (!split) {
    return {
      found: false,
      package: pkg,
      symbol,
      reason: "package_not_installed",
    };
  }
  const { packageName, subpath } = split;

  // 2. Read installed version. Missing → package_not_installed (not cached,
  //    version unknown).
  const packageJsonPath = join(repoRoot, "node_modules", packageName, "package.json");
  let pkgJson: Record<string, unknown>;
  let version: string;
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    pkgJson = JSON.parse(raw) as Record<string, unknown>;
    const v = pkgJson["version"];
    if (typeof v !== "string" || v.length === 0) {
      return { found: false, package: pkg, symbol, reason: "package_not_installed" };
    }
    version = v;
  } catch {
    return { found: false, package: pkg, symbol, reason: "package_not_installed" };
  }

  // 3. Cache check.
  const cached = readCache(pkg, version, symbol);
  if (cached) return cached;

  try {
    // 4. Resolve .d.ts file path(s) to try.
    const dtsCandidates = await resolveDtsCandidates({
      repoRoot,
      packageName,
      subpath,
      packageJson: pkgJson,
    });
    if (dtsCandidates.length === 0) {
      return writeCacheNegative(pkg, version, symbol, "no_types");
    }

    // 5. Parse + build symbol table across candidates (try each until one
    //    yields the symbol). For a single package, candidates are tried in
    //    preference order; the first one that *resolves the symbol* wins.
    //    If no candidate resolves the symbol but at least one parsed, the
    //    result is `symbol_not_found`, not `no_types`.
    let lastTable: SymbolTable | null = null;
    let lastEntrypoint: string | null = null;
    for (const candidate of dtsCandidates) {
      const table = await safeBuildSymbolTable(candidate);
      if (table === null) continue;
      lastTable = table;
      lastEntrypoint = candidate;
      const hit = table.get(symbol);
      if (hit) {
        const dtsRel = toRepoRelative(repoRoot, hit.dtsAbsPath);
        return writeCachePositive(pkg, version, symbol, hit, dtsRel);
      }
    }

    if (lastTable === null) {
      // Every candidate failed to even parse — treat as no_types.
      void lastEntrypoint;
      return writeCacheNegative(pkg, version, symbol, "no_types");
    }
    return writeCacheNegative(pkg, version, symbol, "symbol_not_found");
  } catch {
    // Resolver-internal exception: swallow per ADR-0026 §9. The
    // discriminated union is the contract; raw errors thrown into the AI
    // SDK's tool-use loop would surface as model-side errors.
    return writeCacheNegative(pkg, version, symbol, "lookup_error");
  }
}

// ---------------------------------------------------------------------------
// 1. splitImportPath
// ---------------------------------------------------------------------------

interface ImportPathSplit {
  packageName: string;
  subpath: string;
}

function splitImportPath(pkg: string): ImportPathSplit | null {
  if (pkg.length === 0) return null;
  if (pkg.startsWith("@")) {
    // Scoped: `@scope/name` or `@scope/name/sub/path`.
    const firstSlash = pkg.indexOf("/");
    if (firstSlash === -1) return null; // malformed `@foo` with no second segment
    const secondSlash = pkg.indexOf("/", firstSlash + 1);
    if (secondSlash === -1) {
      return { packageName: pkg, subpath: "" };
    }
    return {
      packageName: pkg.slice(0, secondSlash),
      subpath: pkg.slice(secondSlash + 1),
    };
  }
  const slash = pkg.indexOf("/");
  if (slash === -1) return { packageName: pkg, subpath: "" };
  return {
    packageName: pkg.slice(0, slash),
    subpath: pkg.slice(slash + 1),
  };
}

// ---------------------------------------------------------------------------
// 4. resolveDtsCandidates
// ---------------------------------------------------------------------------

interface ResolveOpts {
  repoRoot: string;
  packageName: string;
  subpath: string;
  packageJson: Record<string, unknown>;
}

async function resolveDtsCandidates(opts: ResolveOpts): Promise<string[]> {
  const { repoRoot, packageName, subpath, packageJson } = opts;
  const pkgDir = join(repoRoot, "node_modules", packageName);
  const typesPkgName = atTypesPackageName(packageName);
  const typesPkgDir = join(repoRoot, "node_modules", typesPkgName);

  const candidates: string[] = [];
  const pushIfExists = async (absPath: string) => {
    if (await fileExists(absPath)) candidates.push(absPath);
  };

  if (subpath === "") {
    // Root entrypoint.
    // a) `package.json#types` / `#typings`.
    for (const key of ["types", "typings"]) {
      const v = packageJson[key];
      if (typeof v === "string") {
        await pushIfExists(resolvePath(pkgDir, v));
      }
    }
    // b) `package.json#exports['.']`.
    const exportsField = packageJson["exports"];
    const fromExports = pickTypesFromExports(exportsField, ".");
    if (fromExports) await pushIfExists(resolvePath(pkgDir, fromExports));

    // c) `@types/<pkg>/index.d.ts`.
    await pushIfExists(join(typesPkgDir, "index.d.ts"));
  } else {
    // Subpath import.
    // a) `package.json#exports['./<subpath>']`.
    const exportsField = packageJson["exports"];
    const fromExports = pickTypesFromExports(exportsField, "./" + subpath);
    if (fromExports) await pushIfExists(resolvePath(pkgDir, fromExports));

    // b) `package.json#typesVersions['*'][<subpath>]`.
    const typesVersions = packageJson["typesVersions"];
    if (typesVersions && typeof typesVersions === "object") {
      // Walk version ranges in declaration order; first matching wins.
      for (const versionRange of Object.keys(typesVersions)) {
        const map = (typesVersions as Record<string, unknown>)[versionRange];
        if (!map || typeof map !== "object") continue;
        const subEntry = (map as Record<string, unknown>)[subpath];
        if (Array.isArray(subEntry) && subEntry.length > 0) {
          const first = subEntry[0];
          if (typeof first === "string") {
            await pushIfExists(resolvePath(pkgDir, first));
          }
        }
      }
    }

    // c) Direct fallbacks.
    await pushIfExists(join(pkgDir, subpath + ".d.ts"));
    await pushIfExists(join(pkgDir, subpath, "index.d.ts"));

    // d) `@types/<pkg>/<subpath>{.d.ts,/index.d.ts}`.
    await pushIfExists(join(typesPkgDir, subpath + ".d.ts"));
    await pushIfExists(join(typesPkgDir, subpath, "index.d.ts"));
  }

  // De-dupe preserving order — multiple resolution paths can land on the
  // same file (e.g., `types` + `exports['.']` both point to `dist/index.d.ts`).
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      deduped.push(c);
    }
  }
  return deduped;
}

/**
 * Translate `lodash` → `@types/lodash`, `@scope/pkg` → `@types/scope__pkg`.
 * `@types/*` packages don't preserve the scope structure — they collapse it
 * with `__`. This is the convention DefinitelyTyped publishes under.
 */
function atTypesPackageName(packageName: string): string {
  if (packageName.startsWith("@")) {
    // `@scope/name` → `@types/scope__name`
    const slash = packageName.indexOf("/");
    if (slash === -1) return "@types/" + packageName.slice(1);
    const scope = packageName.slice(1, slash);
    const name = packageName.slice(slash + 1);
    return "@types/" + scope + "__" + name;
  }
  return "@types/" + packageName;
}

/**
 * Walk a `package.json#exports` field for the given key (`.` or
 * `./<subpath>`) and pull out a `.d.ts`-shaped destination. Honors:
 *  - string-shaped entries (`"./sub": "./dist/sub.d.ts"`) — accepted as-is.
 *  - object-shaped conditional entries — prefers `types`, then `import`,
 *    then `require`, then `default`. For non-`types` conditions, accepts
 *    only when the resolved string ends in `.d.ts`.
 */
function pickTypesFromExports(exportsField: unknown, key: string): string | undefined {
  if (!exportsField || typeof exportsField !== "object") return undefined;
  const exportsMap = exportsField as Record<string, unknown>;

  // The exports field can itself be a single shape for `.` (no nested
  // keys). Handle that for the root case.
  if (key === "." && !Object.keys(exportsMap).some((k) => k.startsWith("."))) {
    return pickFromConditionalShape(exportsField);
  }

  const entry = exportsMap[key];
  if (entry === undefined) return undefined;
  return pickFromConditionalShape(entry);
}

function pickFromConditionalShape(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    // Prefer `types`.
    if (typeof obj["types"] === "string") return obj["types"];
    if (obj["types"] && typeof obj["types"] === "object") {
      const recur = pickFromConditionalShape(obj["types"]);
      if (recur) return recur;
    }
    // Then default / import / require — only if they land on a `.d.ts`.
    for (const k of ["default", "import", "require"]) {
      const v = obj[k];
      if (typeof v === "string" && v.endsWith(".d.ts")) return v;
      if (v && typeof v === "object") {
        const recur = pickFromConditionalShape(v);
        if (recur && recur.endsWith(".d.ts")) return recur;
      }
    }
  }
  return undefined;
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function toRepoRelative(repoRoot: string, abs: string): string {
  const rel = relative(resolvePath(repoRoot), abs);
  return rel.length === 0 ? abs : rel;
}

// ---------------------------------------------------------------------------
// 5. Symbol table construction.
// ---------------------------------------------------------------------------

async function safeBuildSymbolTable(entrypointAbsPath: string): Promise<SymbolTable | null> {
  try {
    const content = await fs.readFile(entrypointAbsPath, "utf8");
    return await buildSymbolTable(entrypointAbsPath, content, 0, new Set());
  } catch {
    return null;
  }
}

async function buildSymbolTable(
  absDtsPath: string,
  content: string,
  depth: number,
  visited: Set<string>,
): Promise<SymbolTable> {
  if (depth > REEXPORT_DEPTH_CAP || visited.has(absDtsPath)) {
    return new Map();
  }
  visited.add(absDtsPath);

  const sf = ts.createSourceFile(absDtsPath, content, ts.ScriptTarget.Latest, true);
  const table: SymbolTable = new Map();

  // Phase 1: local declarations.
  for (const stmt of sf.statements) {
    walkStatement(stmt, sf, absDtsPath, table);
  }

  // Phase 2: re-exports. Resolution: the source specifier is relative to
  // the *current* .d.ts file.
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const sub = stmt.moduleSpecifier.text;
    const subAbs = await resolveRelativeDts(absDtsPath, sub);
    if (!subAbs) continue;
    let subContent: string;
    try {
      subContent = await fs.readFile(subAbs, "utf8");
    } catch {
      continue;
    }
    const subTable = await buildSymbolTable(subAbs, subContent, depth + 1, visited);

    if (stmt.exportClause === undefined) {
      // `export * from './sub'` — merge everything not already locally bound.
      for (const [name, entry] of subTable) {
        if (!table.has(name)) table.set(name, entry);
      }
    } else if (ts.isNamedExports(stmt.exportClause)) {
      // `export { X, Y as Z } from './sub'` — selective merge with renames.
      for (const spec of stmt.exportClause.elements) {
        const srcName = (spec.propertyName ?? spec.name).text;
        const destName = spec.name.text;
        for (const [k, v] of subTable) {
          if (k === srcName && !table.has(destName)) {
            table.set(destName, v);
          } else if (k.startsWith(srcName + ".")) {
            const renamed = destName + k.slice(srcName.length);
            if (!table.has(renamed)) table.set(renamed, v);
          }
        }
      }
    } else if (ts.isNamespaceExport(stmt.exportClause)) {
      // `export * as NS from './sub'` — prefix every sub symbol with `NS.`.
      const ns = stmt.exportClause.name.text;
      for (const [k, v] of subTable) {
        const renamed = ns + "." + k;
        if (!table.has(renamed)) table.set(renamed, v);
      }
    }
  }

  return table;
}

async function resolveRelativeDts(fromAbs: string, spec: string): Promise<string | null> {
  if (!spec.startsWith(".") && !isAbsolute(spec)) {
    // Bare specifier (`'react'`). M11 doesn't follow bare specifiers — that
    // would require a full Node resolution dance against the host package's
    // `node_modules`. Real `.d.ts` re-exports overwhelmingly use relative
    // paths.
    return null;
  }
  const fromDir = dirname(fromAbs);
  const base = isAbsolute(spec) ? spec : resolvePath(fromDir, spec);

  // TypeScript rewrites JS-extension imports in `.d.ts` files to their
  // declaration counterparts: `export * from './sub.js'` resolves to
  // `./sub.d.ts`. Mirror that — strip any `.js` / `.cjs` / `.mjs` /
  // `.jsx` / `.tsx` / `.ts` suffix before extension-probing, and also
  // keep the original `base` as a candidate (which catches `'./sub.d.ts'`
  // and bare `'./sub'` once `.d.ts` is appended).
  const stripped = base.replace(/\.(js|cjs|mjs|jsx|tsx|ts)$/i, "");

  const candidates = [
    base,
    base + ".d.ts",
    base + ".d.cts",
    base + ".d.mts",
    stripped + ".d.ts",
    stripped + ".d.cts",
    stripped + ".d.mts",
    join(base, "index.d.ts"),
    join(stripped, "index.d.ts"),
  ];
  // De-dupe preserving order.
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (await fileExists(c)) return c;
  }
  return null;
}

function walkStatement(
  stmt: ts.Statement,
  sf: ts.SourceFile,
  absDtsPath: string,
  table: SymbolTable,
): void {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    addEntry(table, stmt.name.text, stmt, sf, absDtsPath, "function");
    if (hasDefaultExportModifier(stmt)) {
      addEntry(table, "default", stmt, sf, absDtsPath, "function");
    }
    return;
  }
  if (ts.isClassDeclaration(stmt)) {
    const name = stmt.name?.text;
    if (name) {
      addEntry(table, name, stmt, sf, absDtsPath, "class");
      walkClassMembers(stmt, sf, absDtsPath, table, name);
      if (hasDefaultExportModifier(stmt)) {
        addEntry(table, "default", stmt, sf, absDtsPath, "class");
      }
    } else if (hasDefaultExportModifier(stmt)) {
      addEntry(table, "default", stmt, sf, absDtsPath, "class");
    }
    return;
  }
  if (ts.isInterfaceDeclaration(stmt)) {
    addEntry(table, stmt.name.text, stmt, sf, absDtsPath, "interface");
    walkInterfaceMembers(stmt, sf, absDtsPath, table, stmt.name.text);
    return;
  }
  if (ts.isTypeAliasDeclaration(stmt)) {
    addEntry(table, stmt.name.text, stmt, sf, absDtsPath, "type");
    return;
  }
  if (ts.isEnumDeclaration(stmt)) {
    addEntry(table, stmt.name.text, stmt, sf, absDtsPath, "enum");
    return;
  }
  if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
    const name = stmt.name.text;
    addEntry(table, name, stmt, sf, absDtsPath, "namespace");
    walkNamespaceBody(stmt, sf, absDtsPath, table, name);
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) {
        addEntry(table, d.name.text, d, sf, absDtsPath, "variable");
      }
    }
    return;
  }
  if (ts.isExportAssignment(stmt)) {
    // `export = X` or `export default X`. Bind both.
    addEntry(table, "default", stmt, sf, absDtsPath, "variable");
    return;
  }
}

function walkClassMembers(
  cls: ts.ClassDeclaration,
  sf: ts.SourceFile,
  absDtsPath: string,
  table: SymbolTable,
  className: string,
): void {
  for (const member of cls.members) {
    if (!member.name) continue;
    if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) continue;
    const name = member.name.text;
    const memberPath = className + "." + name;
    if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
      addEntry(table, memberPath, member, sf, absDtsPath, "method");
    } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
      addEntry(table, memberPath, member, sf, absDtsPath, "property");
    }
  }
}

function walkInterfaceMembers(
  iface: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  absDtsPath: string,
  table: SymbolTable,
  ifaceName: string,
): void {
  for (const member of iface.members) {
    if (!member.name) continue;
    if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) continue;
    const name = member.name.text;
    const memberPath = ifaceName + "." + name;
    if (ts.isMethodSignature(member)) {
      addEntry(table, memberPath, member, sf, absDtsPath, "method");
    } else if (ts.isPropertySignature(member)) {
      addEntry(table, memberPath, member, sf, absDtsPath, "property");
    }
  }
}

function walkNamespaceBody(
  mod: ts.ModuleDeclaration,
  sf: ts.SourceFile,
  absDtsPath: string,
  table: SymbolTable,
  prefix: string,
): void {
  const body = mod.body;
  if (!body) return;
  if (ts.isModuleBlock(body)) {
    for (const stmt of body.statements) {
      walkStatementPrefixed(stmt, sf, absDtsPath, table, prefix);
    }
  } else if (ts.isModuleDeclaration(body) && ts.isIdentifier(body.name)) {
    // Nested namespace shorthand: `namespace A.B { ... }` parses as A
    // containing module-decl B.
    walkNamespaceBody(body, sf, absDtsPath, table, prefix + "." + body.name.text);
  }
}

function walkStatementPrefixed(
  stmt: ts.Statement,
  sf: ts.SourceFile,
  absDtsPath: string,
  table: SymbolTable,
  prefix: string,
): void {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    addEntry(table, prefix + "." + stmt.name.text, stmt, sf, absDtsPath, "function");
    return;
  }
  if (ts.isClassDeclaration(stmt) && stmt.name) {
    const name = stmt.name.text;
    const path = prefix + "." + name;
    addEntry(table, path, stmt, sf, absDtsPath, "class");
    walkClassMembers(stmt, sf, absDtsPath, table, path);
    return;
  }
  if (ts.isInterfaceDeclaration(stmt)) {
    const path = prefix + "." + stmt.name.text;
    addEntry(table, path, stmt, sf, absDtsPath, "interface");
    walkInterfaceMembers(stmt, sf, absDtsPath, table, path);
    return;
  }
  if (ts.isTypeAliasDeclaration(stmt)) {
    addEntry(table, prefix + "." + stmt.name.text, stmt, sf, absDtsPath, "type");
    return;
  }
  if (ts.isEnumDeclaration(stmt)) {
    addEntry(table, prefix + "." + stmt.name.text, stmt, sf, absDtsPath, "enum");
    return;
  }
  if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
    const nested = prefix + "." + stmt.name.text;
    addEntry(table, nested, stmt, sf, absDtsPath, "namespace");
    walkNamespaceBody(stmt, sf, absDtsPath, table, nested);
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) {
        addEntry(table, prefix + "." + d.name.text, d, sf, absDtsPath, "variable");
      }
    }
    return;
  }
}

function addEntry(
  table: SymbolTable,
  name: string,
  node: ts.Node,
  sf: ts.SourceFile,
  absDtsPath: string,
  kind: TypeDefKind,
): void {
  if (table.has(name)) return; // first declaration wins (matches TS overload merge posture)
  const signature = extractSignatureText(node, sf);
  const { line_start, line_end } = lineRange(node, sf);
  const jsdoc = extractJsdoc(node, sf);
  table.set(name, { kind, signature, jsdoc, dtsAbsPath: absDtsPath, line_start, line_end });
}

function extractSignatureText(node: ts.Node, sf: ts.SourceFile): string {
  const fullText = node.getText(sf);

  // Strip body for function-like declarations + namespaces + classes.
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body) {
      const rel = body.getStart(sf) - node.getStart(sf);
      return collapseWhitespace(fullText.slice(0, rel));
    }
  }
  if (ts.isClassDeclaration(node) || ts.isModuleDeclaration(node)) {
    const idx = fullText.indexOf("{");
    if (idx !== -1) return collapseWhitespace(fullText.slice(0, idx));
  }
  // Interface / type alias / enum / variable / property keep their full text.
  return collapseWhitespace(fullText);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function lineRange(node: ts.Node, sf: ts.SourceFile): { line_start: number; line_end: number } {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { line_start: start.line + 1, line_end: end.line + 1 };
}

function extractJsdoc(node: ts.Node, sf: ts.SourceFile): string | null {
  const fullText = sf.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) ?? [];
  for (const r of ranges) {
    const text = fullText.slice(r.pos, r.end);
    if (text.startsWith("/**")) {
      return text;
    }
  }
  return null;
}

function hasDefaultExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node) ?? [];
  const hasExport = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const hasDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  return hasExport && hasDefault;
}

// ---------------------------------------------------------------------------
// Cache I/O.
// ---------------------------------------------------------------------------

function readCache(pkg: string, version: string, symbol: string): LookupTypeDefResult | null {
  const row = db()
    .select()
    .from(typeDefCache)
    .where(
      and(
        eq(typeDefCache.package, pkg),
        eq(typeDefCache.version, version),
        eq(typeDefCache.symbol, symbol),
      ),
    )
    .get();
  if (!row) return null;
  return rowToResult(row, pkg, version, symbol);
}

interface TypeDefRow {
  package: string;
  version: string;
  symbol: string;
  found: boolean;
  kind: string | null;
  signature: string | null;
  jsdoc: string | null;
  dts_file: string | null;
  line_start: number | null;
  line_end: number | null;
  reason: string | null;
  retrievedAt: string;
}

function rowToResult(
  row: TypeDefRow,
  pkg: string,
  version: string,
  symbol: string,
): LookupTypeDefResult {
  if (row.found) {
    const kind = row.kind as TypeDefKind;
    const signature = row.signature ?? "";
    const dts_file = row.dts_file ?? "";
    const line_start = row.line_start ?? 1;
    const line_end = row.line_end ?? line_start;
    return {
      found: true,
      package: pkg,
      version,
      symbol,
      signature,
      kind,
      jsdoc: row.jsdoc,
      dts_file,
      line_start,
      line_end,
      suggestedSource: buildSuggestedSource({
        pkg,
        version,
        symbol,
        kind,
        signature,
        dts_file,
        line_start,
        retrievedAt: row.retrievedAt,
      }),
    };
  }
  return {
    found: false,
    package: pkg,
    symbol,
    reason: (row.reason ?? "lookup_error") as NotFoundReason,
  };
}

function writeCachePositive(
  pkg: string,
  version: string,
  symbol: string,
  entry: SymbolEntry,
  dtsRel: string,
): LookupTypeDefResult {
  const retrievedAt = new Date().toISOString();
  const values = {
    package: pkg,
    version,
    symbol,
    found: true,
    kind: entry.kind,
    signature: entry.signature,
    jsdoc: entry.jsdoc,
    dts_file: dtsRel,
    line_start: entry.line_start,
    line_end: entry.line_end,
    reason: null,
    retrievedAt,
  };
  try {
    db()
      .insert(typeDefCache)
      .values(values)
      .onConflictDoUpdate({
        target: [typeDefCache.package, typeDefCache.version, typeDefCache.symbol],
        set: {
          found: values.found,
          kind: values.kind,
          signature: values.signature,
          jsdoc: values.jsdoc,
          dts_file: values.dts_file,
          line_start: values.line_start,
          line_end: values.line_end,
          reason: values.reason,
          retrievedAt: values.retrievedAt,
        },
      })
      .run();
  } catch {
    // Cache write failure is non-fatal — the lookup result still flows
    // through to the caller. Repeated misses will re-do the work.
  }
  return {
    found: true,
    package: pkg,
    version,
    symbol,
    signature: entry.signature,
    kind: entry.kind,
    jsdoc: entry.jsdoc,
    dts_file: dtsRel,
    line_start: entry.line_start,
    line_end: entry.line_end,
    suggestedSource: buildSuggestedSource({
      pkg,
      version,
      symbol,
      kind: entry.kind,
      signature: entry.signature,
      dts_file: dtsRel,
      line_start: entry.line_start,
      retrievedAt,
    }),
  };
}

function writeCacheNegative(
  pkg: string,
  version: string,
  symbol: string,
  reason: NotFoundReason,
): LookupTypeDefResult {
  const retrievedAt = new Date().toISOString();
  try {
    db()
      .insert(typeDefCache)
      .values({
        package: pkg,
        version,
        symbol,
        found: false,
        kind: null,
        signature: null,
        jsdoc: null,
        dts_file: null,
        line_start: null,
        line_end: null,
        reason,
        retrievedAt,
      })
      .onConflictDoUpdate({
        target: [typeDefCache.package, typeDefCache.version, typeDefCache.symbol],
        set: {
          found: false,
          kind: null,
          signature: null,
          jsdoc: null,
          dts_file: null,
          line_start: null,
          line_end: null,
          reason,
          retrievedAt,
        },
      })
      .run();
  } catch {
    // Cache write failure is non-fatal.
  }
  return { found: false, package: pkg, symbol, reason };
}

interface BuildSourceArgs {
  pkg: string;
  version: string;
  symbol: string;
  kind: TypeDefKind;
  signature: string;
  dts_file: string;
  line_start: number;
  retrievedAt: string;
}

function buildSuggestedSource(args: BuildSourceArgs): SuggestedApiDefSource {
  return {
    type: "api_def",
    id: `${args.pkg}@${args.version}#${args.symbol}`,
    title: `${args.kind} ${args.symbol}`,
    path: args.dts_file,
    line: args.line_start,
    snippet: args.signature,
    retrievedAt: args.retrievedAt,
  };
}
