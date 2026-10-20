// Writes docs/enforced-rules.md, the catalog of every rule that a gate enforces,
// from the files that define those rules. With `--check` it writes nothing and
// fails when the committed catalog differs from what the sources produce now.
//
// Ported from alfred's script of the same name (alfred PR #1405), scaled to
// warden: no consolidation or tautology tables. A rule's enforcement status has
// one home, the gate that runs it. This script reads those gates and writes what
// they say, so the catalog cannot drift from them and no person keeps a second
// table by hand.
//
// Sources, and what each contributes:
//   - .oxlintrc.json (JSONC): every rule at "error", its options, the comment
//     directly above its key (the reason), the `overrides` that turn rules off
//     or on (with the comment above each `files` key), and `ignorePatterns`.
//     Built-in rules get the docs link and the type-aware flag from
//     `oxlint --rules -f json`.
//   - each `jsPlugins` entry in that config: the rule's own
//     `meta.docs.description`.
//   - packages/config/tsconfig.base.json and scripts/tsconfig.json: the
//     type-check flags, and the `extends` of each workspace tsconfig.
//   - package.json and .github/workflows/check.yml: which scripts run in
//     `pnpm check` and in CI, with the first comment paragraph of each script
//     file.
//
// The reason comment. A built-in rule at "error" takes its reason from the
// comment block directly above its key. A key that directly follows another key,
// with no comment and no blank line between them, shares that key's comment when
// the comment names it (`no-misused-promises`, or a family such as `no-unsafe-*`);
// the catalog prints such keys in one row. A built-in rule with no reason fails
// this script. Do not add per-rule prose here; change the comment, the rule's
// description, or the script's header at its source.
//
// The output is byte-stable: rows are sorted, and the file holds no timestamp.
//
// Usage: node scripts/enforced-rules-catalog.mjs [--check]
//   (no flag)  write the catalog.
//   --check    write nothing; exit non-zero when the committed catalog differs
//              from what the sources produce now.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CATALOG = "docs/enforced-rules.md";

const OXLINT_CONFIG = ".oxlintrc.json";

const CI_WORKFLOW = ".github/workflows/check.yml";

const TSCONFIGS = ["packages/config/tsconfig.base.json", "scripts/tsconfig.json"];

const WORKSPACE_DIRS = ["apps", "packages"];

const WRITE_COMMAND = "pnpm rules:catalog";

const CHECK = process.argv.includes("--check");

const OXLINT_BIN = resolve(ROOT, "node_modules/.bin/oxlint");

/** The severity spellings that fail `pnpm lint`. */
const ERROR_SPELLINGS = new Set(["error", "deny", 2]);

/** The severity spellings that turn a rule off. */
const OFF_SPELLINGS = new Set(["off", "allow", 0]);

/**
 * The tsc flags that change what `pnpm check-types` accepts, with what each one
 * checks. A flag in neither tsconfig is not printed. Flags that only shape the
 * output or module resolution (`target`, `paths`, `allowJs`) are not rules, so
 * they are not here.
 */
const TSC_FLAGS = new Map([
  ["allowUnreachableCode", "When `false`, code after a `return` or `throw` is an error."],
  ["allowUnusedLabels", "When `false`, an unused label is an error."],
  ["alwaysStrict", "Each file is parsed in strict mode."],
  ["checkJs", "JavaScript files are type-checked, with JSDoc as their types."],
  [
    "erasableSyntaxOnly",
    "TypeScript syntax that has runtime behavior (`enum`, a parameter property) is an error.",
  ],
  [
    "exactOptionalPropertyTypes",
    "An optional property `k?: T` does not accept an explicit `undefined`. Omit the key instead.",
  ],
  [
    "forceConsistentCasingInFileNames",
    "An import whose casing differs from the file on disk is an error.",
  ],
  ["isolatedDeclarations", "Each exported declaration states the types a declaration file needs."],
  [
    "isolatedModules",
    "Each file compiles alone, so a single-file transpiler gives the same output.",
  ],
  [
    "noFallthroughCasesInSwitch",
    "A `case` with statements that falls through to the next `case` is an error.",
  ],
  ["noImplicitAny", "A binding whose type tsc cannot infer is an error, not an implicit `any`."],
  ["noImplicitOverride", "A method that overrides a base method says `override`."],
  ["noImplicitReturns", "A function that returns a value on one path returns one on every path."],
  ["noImplicitThis", "A `this` with an implicit `any` type is an error."],
  [
    "noPropertyAccessFromIndexSignature",
    'A key from an index signature is read with `x["k"]`, not `x.k`.',
  ],
  [
    "noUncheckedIndexedAccess",
    "An index read (`xs[i]`, `record[key]`) has the type `T | undefined`.",
  ],
  ["noUncheckedSideEffectImports", 'A side-effect import (`import "x"`) must resolve.'],
  ["noUnusedLocals", "An unused local declaration is an error."],
  ["noUnusedParameters", "An unused parameter is an error. A leading `_` keeps one on purpose."],
  ["skipLibCheck", "When `true`, tsc does not type-check declaration files (`.d.ts`)."],
  [
    "strict",
    "Turns on the strict family: `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `useUnknownInCatchVariables` and the rest.",
  ],
  ["strictBindCallApply", "`bind`, `call` and `apply` check their arguments."],
  ["strictBuiltinIteratorReturn", "A built-in iterator's return type is `undefined`, not `any`."],
  ["strictFunctionTypes", "Function parameters are checked contravariantly."],
  ["strictNullChecks", "`null` and `undefined` are not in every type."],
  [
    "strictPropertyInitialization",
    "A class property is assigned in the constructor or has an initializer.",
  ],
  ["useUnknownInCatchVariables", "A `catch` binding has the type `unknown`, not `any`."],
  [
    "verbatimModuleSyntax",
    "An import used only as a type says `type`, and the emitted imports match the source.",
  ],
]);

/**
 * @typedef {object} BuiltinRuleInfo
 * @property {string}  docsUrl
 * @property {boolean} typeAware
 */

/**
 * @typedef {object} LintRule
 * @property {string}     name    The config key, such as `typescript/no-floating-promises`.
 * @property {unknown[]}  options The options after the severity.
 * @property {string}     reason  The comment above the key, or "".
 * @property {string[]}   onlyIn  Files of the overrides that turn the rule on, when the root does not.
 * @property {string[][]} offIn   Files of each override that turns the rule off.
 */

/**
 * @typedef {object} Jsonc
 * @property {any} value
 * @property {(container: object, key: string | number) => string} comment
 *   The comment block directly above an object member or an array element, or "".
 * @property {(container: object, key: string | number) => string} sharedComment
 *   The comment that a member with no comment of its own inherits from the member
 *   directly above it, or "".
 */

const oxlintConfig = parseJsonc(read(OXLINT_CONFIG), OXLINT_CONFIG);

const config = oxlintConfig.value;

const overrides = readOverrides();

const builtins = readBuiltinRules();

const plugins = await readPluginDescriptions();

const lintRules = collectLintRules();

const fences = collectFences();

const scripts = collectCheckScripts();

const catalog = render();

if (CHECK) {
  const path = resolve(ROOT, CATALOG);
  const committed = existsSync(path) ? readFileSync(path, "utf8") : null;

  if (committed !== catalog) {
    console.error(
      committed === null
        ? `${CATALOG} is missing. Run \`${WRITE_COMMAND}\` and commit the result.`
        : `${CATALOG} is stale: a rule source changed and the catalog did not. Run \`${WRITE_COMMAND}\` and commit the result.`,
    );
    process.exit(1);
  }

  console.log(`${CATALOG} matches its sources.`);
} else {
  writeFileSync(resolve(ROOT, CATALOG), catalog);
  console.log(`Wrote ${CATALOG}.`);
}

/** @param {string} file A repo-relative path. */
function read(file) {
  return readFileSync(resolve(ROOT, file), "utf8");
}

/**
 * Parses JSONC into plain values, and keeps the comment block that leads each
 * object member and array element.
 *
 * A leading comment is the run of comment lines after the previous token and after
 * the last blank line. A comment on the same line as the previous token (`"x":
 * "off", // 6 / 3`) trails that token and leads nothing. A member with no leading
 * comment and no blank line above it inherits the previous member's comment, which
 * `sharedComment` returns.
 *
 * @param {string} text
 * @param {string} file For error messages.
 * @returns {Jsonc}
 */
function parseJsonc(text, file) {
  /** @type {WeakMap<object, Map<string | number, { text: string, own: boolean }>>} */
  const comments = new WeakMap();
  let index = 0;

  /** @param {string} message */
  const fail = (message) => {
    throw new Error(`${file} could not be parsed: ${message} at offset ${index}.`);
  };

  /**
   * Skips whitespace and comments up to the next token.
   *
   * @returns {{ block: string[], blank: boolean }}
   */
  const trivia = () => {
    /** @type {string[]} */
    let block = [];
    let blank = false;
    let sameLine = true;
    let lineEmpty = true;

    while (index < text.length) {
      const char = text[index];

      if (char === "\n") {
        if (!sameLine && lineEmpty) {
          block = [];
          blank = true;
        }
        sameLine = false;
        lineEmpty = true;
        index += 1;
      } else if (char === " " || char === "\t" || char === "\r") {
        index += 1;
      } else if (char === "/" && text[index + 1] === "/") {
        const end = text.indexOf("\n", index);
        const stop = end === -1 ? text.length : end;

        if (!sameLine) block.push(text.slice(index + 2, stop).trim());
        lineEmpty = false;
        index = stop;
      } else if (char === "/" && text[index + 1] === "*") {
        const end = text.indexOf("*/", index + 2);

        if (end === -1) fail("an unterminated block comment");
        if (!sameLine) {
          for (const line of text.slice(index + 2, end).split("\n")) {
            block.push(line.replace(/^\s*\*?\s?/, "").trim());
          }
        }
        lineEmpty = false;
        index = end + 2;
      } else {
        break;
      }
    }

    return { block, blank };
  };

  /** @param {string[]} block */
  const joinBlock = (block) => block.filter(Boolean).join(" ");

  const string = () => {
    const match = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(index, index + 100_000));

    if (!match) return fail("a malformed string");
    index += match[0].length;

    return String(JSON.parse(match[0]));
  };

  /** @param {string} char */
  const expect = (char) => {
    if (text[index] !== char) fail(`expected \`${char}\``);
    index += 1;
  };

  /**
   * Reads the members of an object or the elements of an array.
   *
   * @param {"}" | "]"} close
   * @param {(position: number) => string | number} readKey
   * @param {(key: string | number, value: unknown) => void} store
   * @returns {Map<string | number, { text: string, own: boolean }>}
   */
  const members = (close, readKey, store) => {
    /** @type {Map<string | number, { text: string, own: boolean }>} */
    const notes = new Map();
    let previous = "";
    let position = 0;

    index += 1;

    for (;;) {
      const { block, blank } = trivia();

      if (text[index] === close) {
        index += 1;
        return notes;
      }

      const key = readKey(position);
      const own = block.length > 0;
      const note = own ? joinBlock(block) : blank ? "" : previous;

      store(key, value());
      notes.set(key, { text: note, own });
      previous = note;
      position += 1;

      trivia();
      if (text[index] === ",") index += 1;
      else if (text[index] !== close) fail(`expected \`,\` or \`${close}\``);
    }
  };

  /** @returns {unknown} */
  const value = () => {
    trivia();

    const char = text[index];

    if (char === "{") {
      /** @type {Record<string, unknown>} */
      const out = {};
      const notes = members(
        "}",
        () => {
          const key = string();

          trivia();
          expect(":");
          return key;
        },
        (key, item) => {
          Object.defineProperty(out, key, { value: item, enumerable: true, writable: true });
        },
      );

      comments.set(out, notes);
      return out;
    }

    if (char === "[") {
      /** @type {unknown[]} */
      const out = [];
      const notes = members(
        "]",
        (position) => position,
        (_key, item) => {
          out.push(item);
        },
      );

      comments.set(out, notes);
      return out;
    }

    if (char === '"') return string();

    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(index, index + 64),
    );

    if (!match) return fail("an unexpected character");
    index += match[0].length;

    return JSON.parse(match[0]);
  };

  const parsed = value();

  trivia();
  if (index !== text.length) fail("trailing content");

  return {
    value: parsed,
    comment: (container, key) => {
      const note = comments.get(container)?.get(key);

      return note?.own === true ? note.text : "";
    },
    sharedComment: (container, key) => {
      const note = comments.get(container)?.get(key);

      return note?.own === false ? note.text : "";
    },
  };
}

/**
 * The `overrides` entries, with the comment above each entry's `files` key.
 *
 * @returns {{ files: string[], rules: Record<string, unknown>, reason: string }[]}
 */
function readOverrides() {
  const entries = Array.isArray(config.overrides) ? config.overrides : [];

  return entries.map((entry) => ({
    files: Array.isArray(entry.files) ? entry.files.map(String) : [],
    rules: entry.rules ?? {},
    reason: oxlintConfig.comment(entry, "files"),
  }));
}

/**
 * Every built-in rule oxlint knows, keyed `<scope>/<name>`.
 *
 * @returns {Map<string, BuiltinRuleInfo>}
 */
function readBuiltinRules() {
  const stdout = execFileSync(OXLINT_BIN, ["--rules", "-f", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const parsed = JSON.parse(stdout);

  if (!Array.isArray(parsed)) throw new Error("`oxlint --rules -f json` did not emit an array.");

  /** @type {Map<string, BuiltinRuleInfo>} */
  const rules = new Map();

  for (const entry of parsed) {
    rules.set(`${entry.scope}/${entry.value}`, {
      docsUrl: String(entry.docs_url),
      typeAware: entry.type_aware === true,
    });
  }

  return rules;
}

/**
 * The `meta.docs.description` of every rule each JS plugin registers, keyed
 * `<plugin>/<rule>`.
 *
 * @returns {Promise<Map<string, { plugin: string, description: string }>>}
 */
async function readPluginDescriptions() {
  /** @type {Map<string, { plugin: string, description: string }>} */
  const descriptions = new Map();
  const specifiers = Array.isArray(config.jsPlugins) ? config.jsPlugins.map(String) : [];

  for (const specifier of specifiers) {
    const url = specifier.startsWith(".")
      ? pathToFileURL(resolve(ROOT, specifier)).href
      : specifier;

    const module = await import(url);
    const plugin = module.default;
    const name = String(plugin.meta.name);

    for (const [rule, definition] of Object.entries(plugin.rules)) {
      const description = definition.meta?.docs?.description;

      descriptions.set(`${name}/${rule}`, {
        plugin: name,
        description: description === undefined ? "" : String(description),
      });
    }
  }

  return descriptions;
}

/**
 * The severity of a rule value, with its options.
 *
 * @param {unknown} value
 * @returns {{ severity: "error" | "off" | "other", options: unknown[] }}
 */
function readSeverity(value) {
  const [level, ...options] = Array.isArray(value) ? value : [value];

  if (ERROR_SPELLINGS.has(level)) return { severity: "error", options };

  if (OFF_SPELLINGS.has(level)) return { severity: "off", options };

  return { severity: "other", options };
}

/**
 * Every rule that fails `pnpm lint` somewhere, except `no-restricted-imports`,
 * which {@link collectFences} renders group by group.
 *
 * @returns {LintRule[]}
 */
function collectLintRules() {
  /** @type {Map<string, LintRule>} */
  const rules = new Map();
  const root = config.rules ?? {};

  for (const [name, value] of Object.entries(root)) {
    const { severity, options } = readSeverity(value);

    if (severity === "error") {
      rules.set(name, {
        name,
        options,
        reason: ruleReason(root, name),
        onlyIn: [],
        offIn: [],
      });
    }
  }

  for (const override of overrides) {
    for (const [name, value] of Object.entries(override.rules)) {
      const { severity, options } = readSeverity(value);
      const known = rules.get(name);

      if (severity === "off" && known) known.offIn.push(override.files);

      if (severity === "error" && !Object.hasOwn(root, name)) {
        const added = known ?? {
          name,
          options,
          reason: ruleReason(override.rules, name) || override.reason,
          onlyIn: [],
          offIn: [],
        };

        added.onlyIn.push(...override.files);
        rules.set(name, added);
      }
    }
  }

  rules.delete("no-restricted-imports");

  return [...rules.values()].sort((a, b) => compareText(a.name, b.name));
}

/**
 * The reason for a rule: the comment directly above its key, or a comment that the
 * key inherits from the keys above it when that comment names the rule. A comment
 * names a rule by its name without the plugin prefix (`no-misused-promises`), or by
 * a family pattern that ends in `*` (`no-unsafe-*`). So a key added under another
 * rule's comment has no reason, and the catalog fails on it, instead of printing the
 * other rule's reason.
 *
 * @param {object} rules
 * @param {string} name
 */
function ruleReason(rules, name) {
  const own = oxlintConfig.comment(rules, name);

  if (own !== "") return own;

  const shared = oxlintConfig.sharedComment(rules, name);
  const short = name.slice(name.indexOf("/") + 1);
  const named = new RegExp(`(?<![\\w-])${short.replaceAll("-", "\\-")}(?![\\w-])`).test(shared);
  const family = [...shared.matchAll(/([\w-]+)\*/g)].some((match) =>
    short.startsWith(String(match[1])),
  );

  return named || family ? shared : "";
}

/**
 * The `no-restricted-imports` groups, with the scopes each one does not apply to.
 *
 * An override REPLACES the rule's options, so a root group that an override does
 * not restate is allowed in that override's files. A group that only an override
 * carries applies only there.
 *
 * @returns {{ group: string[], message: string, allowedIn: string[][], onlyIn: string[] }[]}
 */
function collectFences() {
  /** @type {Map<string, { group: string[], message: string, allowedIn: string[][], onlyIn: string[] }>} */
  const groups = new Map();

  for (const { group, message } of fenceGroups(config.rules?.["no-restricted-imports"])) {
    groups.set(JSON.stringify(group), { group, message, allowedIn: [], onlyIn: [] });
  }

  for (const override of overrides) {
    if (!Object.hasOwn(override.rules, "no-restricted-imports")) continue;

    const restated = fenceGroups(override.rules["no-restricted-imports"]);
    const keys = new Set(restated.map(({ group }) => JSON.stringify(group)));

    for (const [key, fence] of groups) {
      if (fence.onlyIn.length === 0 && !keys.has(key)) fence.allowedIn.push(override.files);
    }

    for (const { group, message } of restated) {
      const key = JSON.stringify(group);

      if (!groups.has(key)) {
        groups.set(key, { group, message, allowedIn: [], onlyIn: override.files });
      }
    }
  }

  return [...groups.entries()].sort(([a], [b]) => compareText(a, b)).map(([, fence]) => fence);
}

/**
 * The `patterns` groups of one `no-restricted-imports` value.
 *
 * @param {unknown} value
 * @returns {{ group: string[], message: string }[]}
 */
function fenceGroups(value) {
  const { severity, options } = readSeverity(value);

  if (severity !== "error") return [];

  return options.flatMap((option) => {
    const patterns = option instanceof Object ? Reflect.get(option, "patterns") : undefined;

    if (!Array.isArray(patterns)) return [];

    return patterns.map((pattern) => ({
      group: Array.isArray(pattern.group) ? pattern.group.map(String) : [],
      message: String(pattern.message ?? ""),
    }));
  });
}

/**
 * The docs link and the type-aware flag of a built-in rule.
 *
 * @param {string} name
 * @returns {BuiltinRuleInfo}
 */
function builtinInfo(name) {
  const [prefix, rule] = name.includes("/") ? name.split("/", 2) : ["eslint", name];
  const scope = prefix.replaceAll("-", "_");
  const info = builtins.get(`${scope}/${rule}`);

  if (!info) {
    throw new Error(
      `${OXLINT_CONFIG} sets \`${name}\` to "error", but \`oxlint --rules\` lists no \`${scope}/${rule}\`. ` +
        `Map the prefix in builtinInfo() in scripts/enforced-rules-catalog.mjs.`,
    );
  }

  return info;
}

/**
 * Every root script that `pnpm check` or the CI workflow runs and that is not
 * only a chain of other scripts.
 *
 * @returns {{ name: string, command: string, inCheck: boolean, inCi: boolean, summary: string }[]}
 */
function collectCheckScripts() {
  const commands = scriptCommands(".");

  const workflow = read(CI_WORKFLOW)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  const ciRoots = [...workflow.matchAll(/\bpnpm\s+([\w:-]+)/g)]
    .map((match) => match[1])
    .filter((name) => commands.has(name));

  const inCheck = reachableScripts(["check"], commands);
  const inCi = reachableScripts(ciRoots, commands);

  const names = [...new Set([...inCheck, ...inCi])].filter(
    (name) => !isChain(commands.get(name) ?? ""),
  );

  return names.sort(compareText).map((name) => {
    const command = commands.get(name) ?? "";

    return {
      name,
      command,
      inCheck: inCheck.has(name),
      inCi: inCi.has(name),
      summary: commandSummary(".", command),
    };
  });
}

/**
 * The `scripts` of one package manifest.
 *
 * @param {string} dir A repo-relative package directory.
 * @returns {Map<string, string>}
 */
function scriptCommands(dir) {
  const manifest = JSON.parse(read(join(dir, "package.json")));

  return new Map(
    Object.entries(manifest.scripts ?? {}).map(([name, command]) => [name, String(command)]),
  );
}

/**
 * The scripts that the roots run, through every `pnpm <script>` step.
 *
 * @param {string[]} roots
 * @param {Map<string, string>} commands
 * @returns {Set<string>}
 */
function reachableScripts(roots, commands) {
  /** @type {Set<string>} */
  const seen = new Set();
  const queue = [...roots];

  while (queue.length > 0) {
    const name = queue.shift();

    if (name === undefined || seen.has(name) || !commands.has(name)) continue;
    seen.add(name);

    for (const match of (commands.get(name) ?? "").matchAll(/\bpnpm\s+([\w:-]+)/g)) {
      queue.push(match[1]);
    }
  }

  return seen;
}

/**
 * Whether a command only runs other root scripts.
 *
 * @param {string} command
 */
function isChain(command) {
  return command.split("&&").every((step) => /^\s*pnpm\s+[\w:-]+\s*$/.test(step));
}

/**
 * The first comment paragraph of the script file a command runs, or "". A
 * `pnpm --filter <package> <script>` step is followed into that package.
 *
 * @param {string} dir The repo-relative directory the command runs in.
 * @param {string} command
 * @returns {string}
 */
function commandSummary(dir, command) {
  const filtered = /^pnpm\s+--filter\s+(\S+)\s+([\w:-]+)\s*$/.exec(command);

  if (filtered) {
    const packageDir = workspaceDir(filtered[1]);
    const inner =
      packageDir === undefined ? undefined : scriptCommands(packageDir).get(filtered[2]);

    return packageDir === undefined || inner === undefined ? "" : commandSummary(packageDir, inner);
  }

  const file = /^(?:node|tsx)\b.*?\s((?:\.\/)?[\w./-]+\.(?:mjs|mts|cjs|js|ts))(?:\s|$)/.exec(
    command,
  )?.[1];

  return file === undefined ? "" : fileSummary(join(dir, file));
}

/**
 * The directory of the workspace package with a name, or undefined.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
function workspaceDir(name) {
  for (const parent of WORKSPACE_DIRS) {
    for (const child of readdirSync(resolve(ROOT, parent)).sort(compareText)) {
      const dir = join(parent, child);

      if (!existsSync(resolve(ROOT, dir, "package.json"))) continue;
      if (JSON.parse(read(join(dir, "package.json"))).name === name) return dir;
    }
  }

  return undefined;
}

/**
 * The first comment paragraph of a script file.
 *
 * @param {string} file A repo-relative path.
 */
function fileSummary(file) {
  /** @type {string[]} */
  const paragraph = [];

  for (const line of read(file).split("\n")) {
    if (line.startsWith("#!")) continue;

    const text = /^\s*(?:\/\/|\/\*\*|\*(?!\/))\s?(.*)$/.exec(line);

    if (!text) break;

    const content = text[1].trim();

    if (content === "") {
      if (paragraph.length > 0) break;
      continue;
    }

    paragraph.push(content);
  }

  return paragraph.join(" ");
}

/**
 * Each workspace tsconfig, with the config it extends.
 *
 * @returns {{ file: string, extendsFrom: string }[]}
 */
function collectPrograms() {
  /** @type {{ file: string, extendsFrom: string }[]} */
  const programs = [];
  const files = WORKSPACE_DIRS.flatMap((parent) =>
    readdirSync(resolve(ROOT, parent)).map((child) => join(parent, child, "tsconfig.json")),
  );

  files.push("scripts/tsconfig.json");

  for (const file of files.sort(compareText)) {
    if (!existsSync(resolve(ROOT, file))) continue;

    const parsed = parseJsonc(read(file), file).value;
    const base = parsed.extends;

    programs.push({
      file,
      extendsFrom: Array.isArray(base)
        ? base.map(String).join(", ")
        : base === undefined
          ? ""
          : String(base),
    });
  }

  return programs;
}

/** @returns {string} */
function render() {
  const pluginRules = lintRules.filter((rule) => plugins.has(rule.name));
  const builtinRules = lintRules.filter((rule) => !plugins.has(rule.name));
  const pluginNames = [
    ...new Set(pluginRules.map((rule) => plugins.get(rule.name)?.plugin ?? "")),
  ].sort(compareText);

  const out = [
    "<!-- Generated by scripts/enforced-rules-catalog.mjs. Do not edit this file by hand. -->",
    `<!-- After you change a rule source, run \`${WRITE_COMMAND}\` and commit the result. -->`,
    "",
    "# Enforced rules",
    "",
    "This catalog lists each rule that a gate enforces. A script makes it from the rule sources, so it cannot drift from them.",
    "",
    "- A reviewer does not report a violation of a rule here. The gate already fails on it.",
    "- [code-style.md](./code-style.md) holds the rules, with the rules that only a reviewer enforces.",
    "- [gate-design.md](./gate-design.md) tells which gate a new rule gets, and holds the queue of rules with no gate yet.",
    "",
    `When you add, remove or change a rule in \`${OXLINT_CONFIG}\`, a JS plugin, a tsconfig, \`package.json\` or \`${CI_WORKFLOW}\`, run \`${WRITE_COMMAND}\`. \`pnpm check:rules-catalog\` fails while this file is stale.`,
    "",
    "## Lint rules: oxlint built-ins",
    "",
    `\`pnpm lint\` fails on each rule below. A type-aware rule reads the type of an expression through tsgolint (rung 2 in gate-design.md). A rule applies to each file that \`pnpm lint\` reads, unless the scope tells otherwise. The reason is the comment above the key in \`${OXLINT_CONFIG}\`. Rules that share one comment share one row.`,
    "",
    "The config also keeps oxlint's default `correctness` category on, at `warn`. `pnpm lint` runs with `--deny-warnings`, so those rules also fail the gate. This table lists only the rules that the config names.",
    "",
    "| Rules | Type-aware | Scope | Options | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...builtinRows(builtinRules),
    "",
  ];

  for (const pluginName of pluginNames) {
    out.push(
      `## Lint rules: \`${pluginName}\` plugin`,
      "",
      "`pnpm lint` fails on each rule below. The description is the rule's own `meta.docs.description`. `pnpm check:oxlint-plugin` drives each rule through the root config.",
      "",
      "| Rule | Scope | Description |",
      "| --- | --- | --- |",
      ...pluginRules
        .filter((rule) => plugins.get(rule.name)?.plugin === pluginName)
        .map((rule) =>
          row([
            `\`${rule.name}\``,
            scopeText(rule),
            [plugins.get(rule.name)?.description ?? "", optionsText(rule.options)]
              .filter(Boolean)
              .join(" Options: "),
          ]),
        ),
      "",
    );
  }

  out.push(
    "## Import fences: `no-restricted-imports`",
    "",
    "`pnpm lint` fails when a file imports a specifier in a group below. An override that does not restate a group allows that group in its files.",
    "",
    "| Specifiers | Allowed in | Message |",
    "| --- | --- | --- |",
    ...fences.map((fence) =>
      row([
        fence.group.map((specifier) => `\`${specifier}\``).join(", "),
        fence.onlyIn.length > 0
          ? `Applies only in ${globList(fence.onlyIn)}`
          : fence.allowedIn.map(globList).join("; ") || "nowhere",
        fence.message,
      ]),
    ),
    "",
    "## Overrides",
    "",
    `Each entry in \`overrides\` changes the rules for its files. A later entry wins over an earlier one, so the order is the config order. The reason is the comment above the entry's \`files\` key.`,
    "",
    "| Files | Off | On | Reason |",
    "| --- | --- | --- | --- |",
    ...overrides.map((override) => {
      const entries = Object.entries(override.rules);
      const named = (/** @type {"error" | "off"} */ severity) =>
        entries
          .filter(([, value]) => readSeverity(value).severity === severity)
          .map(([name]) => `\`${name}\``)
          .sort(compareText)
          .join(", ");

      return row([globList(override.files), named("off"), named("error"), override.reason]);
    }),
    "",
    "## Files that lint does not read",
    "",
    `\`ignorePatterns\` in \`${OXLINT_CONFIG}\`. No lint rule reaches these files.`,
    "",
    "| Pattern | Reason |",
    "| --- | --- |",
    ...ignoreRows(),
    "",
    "## Compiler flags",
    "",
    "Each flag below changes what `pnpm check-types` accepts. `true` and `false` are the values in the tsconfig. An empty cell means that the tsconfig does not set the flag, so the TypeScript default applies, or `strict` sets it.",
    "",
    `| Flag | ${TSCONFIGS.map((file) => `\`${file}\``).join(" | ")} | What it checks |`,
    `| --- | ${TSCONFIGS.map(() => "---").join(" | ")} | --- |`,
    ...flagRows(),
    "",
    "Each program below runs in `pnpm check-types`. A program that extends `@warden/config/tsconfig.base.json` gets its flags from the base.",
    "",
    "| tsconfig | Extends |",
    "| --- | --- |",
    ...collectPrograms().map((program) =>
      row([
        `\`${program.file}\``,
        program.extendsFrom === "" ? "nothing" : `\`${program.extendsFrom}\``,
      ]),
    ),
    "",
    "## Check scripts",
    "",
    `Each script below runs in \`pnpm check\`, in CI (\`${CI_WORKFLOW}\`), or in both. The summary is the first comment paragraph of the script file, when the script runs one.`,
    "",
    "| Script | `pnpm check` | CI | Command | Summary |",
    "| --- | --- | --- | --- | --- |",
    ...scripts.map((script) =>
      row([
        `\`${script.name}\``,
        script.inCheck ? "yes" : "no",
        script.inCi ? "yes" : "no",
        code(script.command),
        script.summary,
      ]),
    ),
    "",
  );

  return out.join("\n");
}

/**
 * The built-in rule rows. Rules that share a reason, a scope, options and the
 * type-aware flag share a row.
 *
 * @param {LintRule[]} rules Sorted by name.
 * @returns {string[]}
 */
function builtinRows(rules) {
  /** @type {Map<string, { names: string[], typeAware: boolean, scope: string, options: string, reason: string }>} */
  const groups = new Map();

  for (const rule of rules) {
    if (rule.reason === "") {
      throw new Error(
        `${OXLINT_CONFIG} sets \`${rule.name}\` to "error" with no comment above its key. ` +
          `Write the reason for the rule in a comment directly above the key; the catalog prints it.`,
      );
    }

    const info = builtinInfo(rule.name);
    const scope = scopeText(rule);
    const options = optionsText(rule.options);
    const key = JSON.stringify([rule.reason, info.typeAware, scope, options]);
    const group = groups.get(key) ?? {
      names: [],
      typeAware: info.typeAware,
      scope,
      options,
      reason: rule.reason,
    };

    group.names.push(`[\`${rule.name}\`](${info.docsUrl})`);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) =>
    row([
      group.names.join(", "),
      group.typeAware ? "yes" : "no",
      group.scope,
      group.options,
      group.reason,
    ]),
  );
}

/** @returns {string[]} */
function ignoreRows() {
  const patterns = Array.isArray(config.ignorePatterns) ? config.ignorePatterns : [];

  return patterns
    .map((pattern, position) => ({
      pattern: String(pattern),
      reason: oxlintConfig.comment(patterns, position),
    }))
    .sort((a, b) => compareText(a.pattern, b.pattern))
    .map((entry) => row([`\`${entry.pattern}\``, entry.reason]));
}

/** @returns {string[]} */
function flagRows() {
  const options = TSCONFIGS.map((file) => parseJsonc(read(file), file).value.compilerOptions ?? {});

  return [...TSC_FLAGS.keys()]
    .filter((flag) => options.some((set) => Object.hasOwn(set, flag)))
    .sort(compareText)
    .map((flag) =>
      row([
        `\`${flag}\``,
        ...options.map((set) =>
          Object.hasOwn(set, flag) ? `\`${JSON.stringify(set[flag])}\`` : "",
        ),
        TSC_FLAGS.get(flag) ?? "",
      ]),
    );
}

/**
 * Where a rule applies, when that is not every linted file.
 *
 * @param {LintRule} rule
 */
function scopeText(rule) {
  const parts = [];

  if (rule.onlyIn.length > 0) parts.push(`Only in ${globList(rule.onlyIn)}`);

  if (rule.offIn.length > 0) parts.push(`Off in ${rule.offIn.map(globList).join("; ")}`);

  return parts.join(". ");
}

/** @param {string[]} files */
function globList(files) {
  return files.map((file) => `\`${file}\``).join(", ");
}

/** @param {unknown[]} options */
function optionsText(options) {
  return options.length === 0
    ? ""
    : code(options.map((option) => JSON.stringify(option)).join(", "));
}

/**
 * A Markdown code span whose fence is longer than any backtick run inside it.
 *
 * @param {string} text
 */
function code(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);

  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

/**
 * One Markdown table row. A cell keeps no line break, and a `|` is escaped.
 *
 * @param {string[]} cells
 */
function row(cells) {
  return `| ${cells.map((cell) => cell.replaceAll("\n", " ").replaceAll("|", "\\|")).join(" | ")} |`;
}

/**
 * Code-unit order, so the output does not depend on the ICU data of the machine.
 *
 * @param {string} a
 * @param {string} b
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
