import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import ts from "typescript";

/**
 * Single TS-Compiler-API entry point for the M5 cheap-signals selector
 * (ADR-0018). Exposed behind the `SourceParser` interface so the M6+
 * tree-sitter swap-in for multi-ecosystem can drop in alongside without
 * rewriting selector code. **No selector signal file may import `typescript`
 * directly — only this file does.**
 *
 * `TsCompilerParser` uses a pure parse (no type-check) which costs a few ms
 * per file. Module resolution goes through `ts.resolveModuleName` against
 * the host repo's tsconfig so workspace aliases (`@warden/core`, etc.)
 * resolve correctly inside Turborepos.
 */

export interface ImportRef {
  /** The literal in the import specifier — `"react"`, `"./session"`, `"@warden/core"`. */
  module: string;
  /** Absolute path resolved through tsconfig. Undefined for unresolved/external. */
  resolved?: string;
  kind: "value" | "type";
  /** Named imports. Empty for default-only or namespace-only imports. */
  symbols: string[];
  startLine: number;
  endLine: number;
}

export interface ExportRef {
  /** Exported symbol name (`"login"`, `"default"`, etc.). */
  symbol: string;
  startLine: number;
  endLine: number;
}

export interface SourceParser {
  imports(absPath: string, content: string): Promise<ImportRef[]>;
  exports(absPath: string, content: string): Promise<ExportRef[]>;
}

interface ResolvedTsconfig {
  options: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
  cache: ts.ModuleResolutionCache;
}

export interface TsCompilerParserOptions {
  /** Path to tsconfig.json used for module resolution. Optional — falls back to default options. */
  tsconfigPath?: string;
  /** Repo root for resolution caching. */
  repoRoot: string;
}

export class TsCompilerParser implements SourceParser {
  private readonly resolved: ResolvedTsconfig;

  constructor(opts: TsCompilerParserOptions) {
    this.resolved = loadTsconfig(opts.repoRoot, opts.tsconfigPath);
  }

  async imports(absPath: string, content: string): Promise<ImportRef[]> {
    const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, false);
    const refs: ImportRef[] = [];

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const moduleName = stripQuotes(stmt.moduleSpecifier.getText(sf));
        const isTypeOnly = stmt.importClause?.isTypeOnly ?? false;
        const symbols = collectImportSymbols(stmt);
        const range = lineRange(sf, stmt);
        refs.push({
          module: moduleName,
          resolved: this.resolveModule(moduleName, absPath),
          kind: isTypeOnly ? "type" : "value",
          symbols,
          ...range,
        });
        continue;
      }
      if (
        ts.isImportEqualsDeclaration(stmt) &&
        ts.isExternalModuleReference(stmt.moduleReference)
      ) {
        const expr = stmt.moduleReference.expression;
        if (expr && ts.isStringLiteral(expr)) {
          const moduleName = expr.text;
          const range = lineRange(sf, stmt);
          refs.push({
            module: moduleName,
            resolved: this.resolveModule(moduleName, absPath),
            kind: "value",
            symbols: [stmt.name.text],
            ...range,
          });
        }
        continue;
      }
      if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        // `export { x } from "./m"` and `export * from "./m"` — these import too.
        const moduleName = stmt.moduleSpecifier.text;
        const isTypeOnly = stmt.isTypeOnly;
        const symbols: string[] = [];
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const spec of stmt.exportClause.elements) {
            symbols.push((spec.propertyName ?? spec.name).text);
          }
        }
        const range = lineRange(sf, stmt);
        refs.push({
          module: moduleName,
          resolved: this.resolveModule(moduleName, absPath),
          kind: isTypeOnly ? "type" : "value",
          symbols,
          ...range,
        });
      }
    }

    return refs;
  }

  async exports(absPath: string, content: string): Promise<ExportRef[]> {
    const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, false);
    const refs: ExportRef[] = [];

    for (const stmt of sf.statements) {
      if (hasExportModifier(stmt)) {
        // Use only the declaration's signature line — the prompt-assembly
        // layer adds ±5 lines of padding, so the LLM gets the signature plus
        // surrounding context without the full function body.
        const signatureLine = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
        for (const symbol of namedSymbolsOf(stmt)) {
          refs.push({ symbol, startLine: signatureLine, endLine: signatureLine });
        }
        continue;
      }
      if (ts.isExportAssignment(stmt)) {
        const signatureLine = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
        refs.push({ symbol: "default", startLine: signatureLine, endLine: signatureLine });
        continue;
      }
      if (
        ts.isExportDeclaration(stmt) &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        const signatureLine = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
        for (const spec of stmt.exportClause.elements) {
          refs.push({ symbol: spec.name.text, startLine: signatureLine, endLine: signatureLine });
        }
      }
    }

    return refs;
  }

  private resolveModule(moduleName: string, containingFile: string): string | undefined {
    const result = ts.resolveModuleName(
      moduleName,
      containingFile,
      this.resolved.options,
      this.resolved.host,
      this.resolved.cache,
    );
    const resolved = result.resolvedModule?.resolvedFileName;
    if (!resolved) return undefined;
    // Edges into node_modules don't enter the candidate set per ADR-0018.
    if (resolved.includes(`${"/"}node_modules${"/"}`)) return undefined;
    return resolvePath(resolved);
  }
}

function loadTsconfig(repoRoot: string, tsconfigPath: string | undefined): ResolvedTsconfig {
  const host: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    realpath: ts.sys.realpath,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const cache = ts.createModuleResolutionCache(repoRoot, (s) => s, undefined);

  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
  };

  if (tsconfigPath && existsSync(tsconfigPath)) {
    try {
      const raw = readFileSync(tsconfigPath, "utf8");
      const parsed = ts.parseConfigFileTextToJson(tsconfigPath, raw);
      if (!parsed.error && parsed.config) {
        const resolvedConfig = ts.parseJsonConfigFileContent(
          parsed.config,
          ts.sys,
          dirname(tsconfigPath),
        );
        options = { ...options, ...resolvedConfig.options };
      }
    } catch {
      // Fall through to defaults — the caller surfaces a degraded[] line.
    }
  }

  return { options, host, cache };
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, "");
}

function collectImportSymbols(decl: ts.ImportDeclaration): string[] {
  const symbols: string[] = [];
  const clause = decl.importClause;
  if (!clause) return symbols;
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const spec of clause.namedBindings.elements) {
      symbols.push((spec.propertyName ?? spec.name).text);
    }
  }
  return symbols;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    : false;
}

function namedSymbolsOf(stmt: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) return [stmt.name.text];
  if (ts.isClassDeclaration(stmt) && stmt.name) return [stmt.name.text];
  if (ts.isInterfaceDeclaration(stmt)) return [stmt.name.text];
  if (ts.isTypeAliasDeclaration(stmt)) return [stmt.name.text];
  if (ts.isEnumDeclaration(stmt)) return [stmt.name.text];
  if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) return [stmt.name.text];
  if (ts.isVariableStatement(stmt)) {
    const out: string[] = [];
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) out.push(d.name.text);
    }
    return out;
  }
  return [];
}

function lineRange(sf: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}
