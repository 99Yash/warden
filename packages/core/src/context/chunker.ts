import { createHash } from "node:crypto";
import { chunk as codeChunkChunk, detectLanguage } from "code-chunk";

/**
 * Single AST-aware chunker entry point for the M6 embedding selector
 * (ADR-0019 #2). Wraps `code-chunk` (npm, MIT, pinned). **No file outside
 * this module may import `code-chunk` directly** — same discipline M5
 * uses for the TypeScript Compiler API in `parser.ts`.
 *
 * `chunkHash = sha256(content)` — content-addressed, no whitespace
 * normalization (whitespace changes are real changes per ADR-0019 #3).
 * The provided `fileSha` is recorded for provenance only; the hash key
 * stays purely on chunk content so duplicate snippets across files
 * collapse to one embedding row.
 *
 * Files in unsupported languages return `[]` and stay candidates for
 * M5's cheap signals only — they don't contribute semantic hits but
 * still appear in same-folder / symbol-ref reasons.
 */

/** Per-file chunk count cap. Pathological generated files fall back to []. */
const MAX_CHUNKS_PER_FILE = 100;

/** code-chunk's supported language enum, surfaced for callers. */
export const SUPPORTED_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "rust",
  "go",
  "java",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export interface ChunkRecord {
  /** sha256(content). Primary key in the `chunks` table. */
  chunkHash: string;
  /** Repo-relative POSIX path of the source file. */
  filePath: string;
  /** SHA of the file's content this chunk was extracted from (provenance only). */
  fileSha: string;
  /** code-chunk's detected language. */
  language: SupportedLanguage;
  /** Best-effort scope chain — `["ClassFoo","method bar"]`. May be empty. */
  symbolPath: string[];
  /** 1-indexed inclusive start line. */
  startLine: number;
  /** 1-indexed inclusive end line. */
  endLine: number;
  /** Raw chunk text — exact bytes that get embedded. */
  content: string;
}

export interface Chunker {
  /**
   * @param filePath repo-relative POSIX path
   * @param fileContent UTF-8 source
   * @param fileSha sha256 of `fileContent`, supplied by the caller so the
   *  walker can compute it once per file and reuse for both chunking and
   *  Merkle bookkeeping.
   */
  chunk(filePath: string, fileContent: string, fileSha: string): Promise<ChunkRecord[]>;
  supportedLanguages(): readonly SupportedLanguage[];
  /** Returns `null` for unsupported languages (caller should skip the file). */
  detectLanguage(filePath: string): SupportedLanguage | null;
}

/**
 * Default `Chunker` implementation backed by `code-chunk`'s native
 * tree-sitter parsers. Native bindings are first-class on macOS / Linux /
 * Windows via the package's prebuilds; the WASM swap-in (`code-chunk/wasm`)
 * is held in reserve for environments where native loads fail.
 */
export class CodeChunkAdapter implements Chunker {
  supportedLanguages(): readonly SupportedLanguage[] {
    return SUPPORTED_LANGUAGES;
  }

  detectLanguage(filePath: string): SupportedLanguage | null {
    const lang = detectLanguage(filePath);
    if (!lang) return null;
    return SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)
      ? (lang as SupportedLanguage)
      : null;
  }

  async chunk(filePath: string, fileContent: string, fileSha: string): Promise<ChunkRecord[]> {
    const language = this.detectLanguage(filePath);
    if (!language) return [];

    const raw = await codeChunkChunk(filePath, fileContent, {
      // Defaults chosen for code-retrieval recall; revisit only with dogfood data.
      contextMode: "minimal",
      siblingDetail: "names",
      filterImports: false,
    });
    if (raw.length === 0) return [];
    if (raw.length > MAX_CHUNKS_PER_FILE) {
      // Pathological — likely a generated file. Skip rather than blow out the
      // embedding budget; surfaces in `degradedWorkers` via the caller.
      return [];
    }

    const records: ChunkRecord[] = [];
    for (const c of raw) {
      const chunkHash = sha256Hex(c.text);
      const symbolPath = (c.context.scope ?? [])
        .map((s) => s.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
      records.push({
        chunkHash,
        filePath,
        fileSha,
        language,
        symbolPath,
        // code-chunk's lineRange is 0-indexed inclusive; the schema is 1-indexed inclusive.
        startLine: c.lineRange.start + 1,
        endLine: c.lineRange.end + 1,
        content: c.text,
      });
    }
    return records;
  }
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
