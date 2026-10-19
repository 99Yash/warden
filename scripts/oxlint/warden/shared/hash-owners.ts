import { readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The closed list of modules that may export a function whose parameter flows
 * into a hash digest. Two rules read it:
 * - `warden/no-exported-hasher` reports such a function exported from any
 *   other module, and a re-export of an owner hasher from any other module;
 * - `warden/sha256-over-json-stringify` treats a call of an owner hasher,
 *   reached through an import of the owner module, as a digest sink.
 * So every cross-file string hasher is on this list, and the one-file rule
 * sees each call of one.
 *
 * `string` is a hasher of text or bytes (`sha256Hex`): the one SHA-256 helper,
 * hex out. A structured value is hashed as `sha256Hex(canonicalJson(value))`;
 * `canonicalJson` returns a string and digests nothing, so it is listed only
 * as a canonicalizer, not a hasher.
 * Alfred's owner also has a `canonical` kind (`sha256Canonical`, which
 * canonicalizes first). Warden has no such helper; the kind stays in the type
 * so this copy diffs cleanly against alfred's.
 */
export const HASH_OWNERS = [
  {
    module: "packages/core/src/hash.ts",
    hashers: new Map([["sha256Hex", "string"]]),
    canonicalizers: new Set(["canonicalJson"]),
  },
] as const satisfies readonly Readonly<{
  module: string;
  hashers: ReadonlyMap<string, "string" | "canonical">;
  canonicalizers: ReadonlySet<string>;
}>[];

export type HashOwner = (typeof HASH_OWNERS)[number];

/**
 * The repo root, from this file's place in it. An owner package's `package.json`
 * is read from here, not from the lint `cwd`, which a RuleTester case sets to the
 * oxlint package.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function repoPath(cwd: string, file: string): string {
  return relative(cwd, file).split(sep).join("/");
}

/** True when `filename` is an owner module, which may define and export hashers. */
export function isOwnerModule(filename: string, cwd: string): boolean {
  const file = repoPath(cwd, filename);

  return HASH_OWNERS.some((owner) => owner.module === file);
}

type PackageExports = Readonly<{ name: string; root: string; exports: Map<string, string | null> }>;

const packageCache = new Map<string, PackageExports | null>();

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** The package manifest in `root`: undefined when there is none, null when it has no `name` and `exports`. */
function readManifest(root: string): PackageExports | null | undefined {
  let manifest: unknown;

  try {
    manifest = JSON.parse(readFileSync(join(REPO_ROOT, root, "package.json"), "utf8"));
  } catch {
    return undefined;
  }

  return parseManifest(root, manifest);
}

/**
 * The `name` and string `exports` targets of the nearest package above
 * `module`, read once per run.
 */
function packageOf(module: string): PackageExports | null {
  const cached = packageCache.get(module);

  if (cached !== undefined) return cached;
  let parsed: PackageExports | null = null;

  for (let root = posix.dirname(module); root !== "." && root !== "/"; root = posix.dirname(root)) {
    const manifest = readManifest(root);

    if (manifest === undefined) continue;
    parsed = manifest;
    break;
  }

  packageCache.set(module, parsed);

  return parsed;
}

function parseManifest(root: string, manifest: unknown): PackageExports | null {
  if (!isObject(manifest)) return null;
  const name: unknown = Reflect.get(manifest, "name");
  const exportsField: unknown = Reflect.get(manifest, "exports");

  if (!isString(name) || !isObject(exportsField)) return null;

  const exports = new Map<string, string | null>();

  for (const [subpath, target] of Object.entries(exportsField)) {
    if (isString(target) || target === null) exports.set(subpath, target);
  }

  return { name, root, exports };
}

/** The package `exports` target of `subpath` (`.`, `./hash`), with one `*` pattern. Null when blocked or absent. */
function exportTarget(exports: Map<string, string | null>, subpath: string): string | null {
  if (exports.has(subpath)) return exports.get(subpath) ?? null;

  for (const [pattern, target] of exports) {
    const star = pattern.indexOf("*");

    if (star === -1 || target === null) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);

    if (
      subpath.length >= prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix)
    ) {
      return target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }

  return null;
}

/** True when the package specifier resolves, through the owner package's `exports`, to the owner module. */
function packageSpecifierIs(specifier: string, owner: HashOwner): boolean {
  const pkg = packageOf(owner.module);

  if (pkg === null) return false;
  let subpath: string | null = null;

  if (specifier === pkg.name) subpath = ".";

  if (specifier.startsWith(`${pkg.name}/`)) subpath = `./${specifier.slice(pkg.name.length + 1)}`;

  if (subpath === null) return false;
  const target = exportTarget(pkg.exports, subpath);

  return target !== null && posix.join(pkg.root, target) === owner.module;
}

/** True when the relative specifier, resolved from `filename`, names the owner module. */
function relativeSpecifierIs(
  specifier: string,
  owner: HashOwner,
  filename: string,
  cwd: string,
): boolean {
  const base = repoPath(cwd, resolve(dirname(filename), specifier));
  const stem = base.replace(/\.(?:[cm]?js|tsx?)$/, "");

  return [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`].includes(owner.module);
}

/** The owner module that `specifier`, imported from `filename`, resolves to. */
export function ownerOfSpecifier(
  specifier: string,
  filename: string,
  cwd: string,
): HashOwner | null {
  const relativeSpecifier = specifier.startsWith("./") || specifier.startsWith("../");

  return (
    HASH_OWNERS.find((owner) =>
      relativeSpecifier
        ? relativeSpecifierIs(specifier, owner, filename, cwd)
        : packageSpecifierIs(specifier, owner),
    ) ?? null
  );
}
