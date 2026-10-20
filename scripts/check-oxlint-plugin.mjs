// Fails when a rule in one of the repo's oxlint JS plugins is untested,
// unregistered, unconfigured, or configured at "error" but not actually
// enforced by the root config.
//
// Ported from alfred's gate of the same name. The plugins live under
// `scripts/oxlint/<plugin>/` and this gate discovers them from the directory,
// so a new plugin or rule is covered without an edit here. Nothing else reaches
// them: no package's `check-types` covers `scripts/` (`scripts/tsconfig.json`
// does), and a rule that is present but never registered lints nothing while
// looking exactly like a rule that works.
//
// The enablement claim is the one worth explaining. It is NOT read out of
// `oxlint --print-config`, which omits JS-plugin rules from its resolved
// `rules`. Instead each "error" rule is DRIVEN: the gate writes snippets that
// violate it to a temp directory, lints that directory through
// `--config .oxlintrc.json`, and demands the rule report each one at `error`.
// A clean tree is why the drive exists: `pnpm lint` is silent whether a rule
// works or is switched off.
//
// Warden-specific: alfred holds every vendored rule at "error". Warden adopts
// them as a ratchet (docs/gate-design.md), so a registered rule must appear in
// the root config either at "error" (driven here) or at "off" (reported in the
// summary as the open queue). A rule the config does not mention fails: it is
// neither enforced nor recorded as a decision.
//
// Where a rule's snippets come from:
// - An entry in PROBES below, when the rule has one.
// - Otherwise, the rule's own `invalid` fixture cases, captured at run time
//   from `RuleTester#run`. Only a case the root config can reproduce counts:
//   one with no `filename`, `options`, `settings`, `languageOptions` or hooks.
//
// Usage: node scripts/check-oxlint-plugin.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RuleTester } from "oxlint/plugins-dev";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PLUGINS_DIR = join("scripts", "oxlint");

const CONFIG_FILE = ".oxlintrc.json";

const GATE_FILE = join("scripts", "check-oxlint-plugin.mjs");

const OXLINT_BIN = resolve(ROOT, "node_modules", ".bin", "oxlint");

// oxlint loads each plugin through Node's native TypeScript support. Below the
// engines floor the symptom is a plugin-load crash that this gate would report
// as "registered but NOT enforced", pointing at the config instead of Node.
const ENGINES_NODE = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).engines?.node;

const ENGINES_FLOOR = /^>=(\d+)\.(\d+)/.exec(String(ENGINES_NODE ?? ""));

if (ENGINES_FLOOR !== null) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const floorMajor = Number(ENGINES_FLOOR[1]);
  const floorMinor = Number(ENGINES_FLOOR[2]);

  if (major < floorMajor || (major === floorMajor && minor < floorMinor)) {
    console.error(
      `This gate is running on Node ${process.versions.node}, but package.json requires ${ENGINES_NODE}. ` +
        `oxlint cannot load a .ts plugin below that floor, so no rule can be driven.`,
    );
    process.exit(1);
  }
}

// Explicit snippets, keyed `<plugin>/<rule>`. Each must violate exactly its own
// rule. `vi` is deliberately left UNDECLARED: no-module-mocking ignores a local
// binding, so a `declare const vi` probe would pass without the rule doing anything.
const PROBES = {
  "anti-slop/no-module-mocking": `vi.mock("./user-store");\n`,
  "anti-slop/no-reflect-apply": `export const value = Reflect.apply(operation, owner, args);\n`,
  "anti-slop/no-widen-then-assert":
    `const source = { id: "second" };\n` +
    `const widened: unknown = source;\n` +
    `export const parsed = widened as { readonly id: string };\n`,
  "anti-slop/no-chained-type-assertions": `export const user = input as object as User;\n`,
  "anti-slop/no-known-value-widening":
    `type Handler = () => void;\n` +
    `const handlers: Record<string, Handler> = { start: startHandler };\n`,
  "anti-slop/no-object-parameters": `export function save(value: object) {}\n`,
  "anti-slop/no-runtime-typeof": `export const isString = typeof input === "string";\n`,
  "anti-slop/no-unknown-returns": `export function loadUser(): unknown { return input; }\n`,
  "anti-slop/no-unknown-type-aliases": `export type ExternalValue = unknown;\n`,
  "anti-slop/no-unsafe-dictionary-type": `export type Metadata = Record<string, unknown>;\n`,
  "anti-slop/require-readable-spacing": `export const first = 1;\nexport const second = 2;\n`,
};

// Linted alongside the probes, so "every probe reported its rule" cannot be
// satisfied by a rule that reports everything.
const CONTROL = `export const ok = { id: "second" };\n`;

const CONTROL_NAME = "control";

const DRIVABLE_CASE_KEYS = new Set(["code", "name", "errors", "output"]);

const failures = [];

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The stdout a failed `execFileSync` captured. oxlint exits 1 on the probes by
 * design, so the throw is the normal path and its `stdout` is the result.
 *
 * @param {unknown} error
 * @returns {string}
 */
function capturedStdout(error) {
  if (typeof error !== "object" || error === null || !("stdout" in error)) return "";

  return typeof error.stdout === "string" ? error.stdout : "";
}

/**
 * Strip `//` and `/* *\/` comments from JSONC, leaving string contents alone.
 *
 * @param {string} text
 * @returns {string}
 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else {
      out += char;
    }
  }

  return out;
}

/**
 * The severity the root config gives a rule: "error", "warn", "off", or
 * undefined when the root `rules` object does not mention it.
 *
 * @param {Record<string, unknown>} configRules
 * @param {string} id
 * @returns {string | undefined}
 */
function severityOf(configRules, id) {
  const value = configRules[id];
  const level = Array.isArray(value) ? value[0] : value;

  if (level === undefined) return undefined;
  if (level === 2 || level === "error" || level === "deny") return "error";
  if (level === 1 || level === "warn") return "warn";

  return "off";
}

let configRules;

try {
  configRules =
    JSON.parse(stripJsonComments(readFileSync(resolve(ROOT, CONFIG_FILE), "utf8"))).rules ?? {};
} catch (error) {
  console.error(`${CONFIG_FILE} could not be parsed (${errorText(error)}).`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Discovery: which plugins and rules exist, and is each rule tested?
// ---------------------------------------------------------------------------

/** @typedef {{ plugin: string, rule: string, rulesDir: string }} PluginRule */

let pluginDirs;

try {
  pluginDirs = readdirSync(resolve(ROOT, PLUGINS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(ROOT, PLUGINS_DIR, name, "index.ts")))
    .sort();
} catch (error) {
  console.error(
    `${PLUGINS_DIR} could not be read (${errorText(error)}). Without it this gate checks nothing.`,
  );
  process.exit(1);
}

// A zero count means the walk is broken, not that the plugins are clean.
if (pluginDirs.length === 0) {
  console.error(`${PLUGINS_DIR} holds no plugin directory with an index.ts.`);
  process.exit(1);
}

/** @type {PluginRule[]} */
const rules = [];

for (const plugin of pluginDirs) {
  const pluginDir = join(PLUGINS_DIR, plugin);
  const rulesDir = join(pluginDir, "rules");
  const indexFile = join(pluginDir, "index.ts");
  const indexSource = readFileSync(resolve(ROOT, indexFile), "utf8");
  const metaName = /meta:\s*\{\s*name:\s*"([a-z0-9-]+)"/.exec(indexSource)?.[1];

  if (metaName !== plugin) {
    failures.push(
      `${indexFile} declares meta.name ${metaName === undefined ? "(none)" : `"${metaName}"`}, not "${plugin}". ` +
        `oxlint configures a rule as "<meta.name>/<rule>", so the directory and the name must agree.`,
    );
    continue;
  }

  let entries;

  try {
    entries = readdirSync(resolve(ROOT, rulesDir));
  } catch (error) {
    failures.push(`${rulesDir} could not be read (${errorText(error)}).`);
    continue;
  }

  const testModules = new Set(entries.filter((name) => name.endsWith(".rule-test.ts")));
  const present = entries
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".rule-test.ts"))
    .map((name) => name.slice(0, -".ts".length))
    .sort();

  if (present.length === 0) {
    failures.push(`${rulesDir} holds no rule module. A zero here means the walk is broken.`);
    continue;
  }

  for (const rule of present) {
    if (!testModules.has(`${rule}.rule-test.ts`)) {
      failures.push(
        `${rulesDir}/${rule}.ts has no sibling ${rule}.rule-test.ts. An untested rule that stops matching ` +
          `fails open and the tree stays green.`,
      );
    }
  }

  const registered = [...indexSource.matchAll(/^\s*"([a-z0-9-]+)":\s*[A-Za-z][A-Za-z0-9]*Rule,$/gm)]
    .map((match) => match[1])
    .sort();

  if (registered.length === 0) {
    failures.push(
      `${indexFile} registers no rule, or its \`rules\` entries no longer match the shape this gate reads.`,
    );
    continue;
  }

  for (const rule of present) {
    if (!registered.includes(rule)) {
      failures.push(
        `${rulesDir}/${rule}.ts is present but not registered in ${indexFile}, so it lints nothing.`,
      );
    }
  }

  for (const rule of registered) {
    if (!present.includes(rule)) {
      failures.push(`${indexFile} registers "${rule}", which has no module in ${rulesDir}.`);
      continue;
    }

    rules.push({ plugin, rule, rulesDir });
  }
}

for (const id of Object.keys(PROBES)) {
  if (!rules.some(({ plugin, rule }) => `${plugin}/${rule}` === id)) {
    failures.push(
      `PROBES holds "${id}", which no plugin registers. A probe for an absent rule reports nothing.`,
    );
  }
}

/** @type {string[]} */
const enforced = [];

/** @type {string[]} */
const queued = [];

for (const { plugin, rule } of rules) {
  const id = `${plugin}/${rule}`;
  const severity = severityOf(configRules, id);

  if (severity === "error") {
    enforced.push(id);
  } else if (severity === "off") {
    queued.push(id);
  } else if (severity === "warn") {
    failures.push(
      `${CONFIG_FILE} sets "${id}" to "warn". A warning enforces nothing; set it to "error" once the tree is ` +
        `at zero, or "off" with its measured count (docs/gate-design.md).`,
    );
  } else {
    failures.push(
      `"${id}" is registered but ${CONFIG_FILE} does not mention it. Add it at "error" (tree at zero) or at ` +
        `"off" with its measured count, so the decision is recorded.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The fixtures: does each rule still match what it claims to? Run in this
// process, so `RuleTester#run` can hand over the `invalid` cases it was given.
// ---------------------------------------------------------------------------

/** @type {Map<string, Array<Record<string, unknown>>>} */
const capturedInvalid = new Map();

/** @type {string | null} */
let capturing = null;

/** @type {string[]} */
let caseFailures = [];

let casesRun = 0;

// oxlint-disable-next-line typescript/unbound-method -- re-bound below with runFixtures.call(this, …)
const runFixtures = RuleTester.prototype.run;

RuleTester.prototype.run = function captureInvalidCases(ruleName, rule, tests) {
  if (capturing !== null) {
    const cases = capturedInvalid.get(capturing) ?? [];

    for (const test of tests.invalid) cases.push({ ...test });
    capturedInvalid.set(capturing, cases);
  }

  return runFixtures.call(this, ruleName, rule, tests);
};

// RuleTester's own `it` throws on the first failing case. This one runs every
// case and keeps each failure, so one broken case does not hide the rest.
RuleTester.it = (name, method) => {
  casesRun += 1;

  try {
    method();
  } catch (error) {
    caseFailures.push(`${name}: ${errorText(error)}`);
  }
};

let suitesRun = 0;

for (const { plugin, rule, rulesDir } of rules) {
  const testFile = join(rulesDir, `${rule}.rule-test.ts`);

  if (!existsSync(resolve(ROOT, testFile))) continue;
  capturing = `${plugin}/${rule}`;
  caseFailures = [];

  const casesBefore = casesRun;

  try {
    await import(pathToFileURL(resolve(ROOT, testFile)).href);
  } catch (error) {
    caseFailures.push(`the file did not load: ${errorText(error)}`);
  }

  capturing = null;

  if (casesRun === casesBefore) caseFailures.push("it ran no RuleTester case");

  if (caseFailures.length > 0) {
    failures.push(`${testFile} failed:\n    ${caseFailures.join("\n    ")}`);
  } else {
    suitesRun += 1;
  }
}

// ---------------------------------------------------------------------------
// The drive: does the ROOT config actually enforce each "error" rule?
// ---------------------------------------------------------------------------

/** @type {Map<string, string[]>} */
const probes = new Map();

for (const id of enforced) {
  if (Object.hasOwn(PROBES, id)) {
    probes.set(id, [PROBES[id]]);
    continue;
  }

  const drivable = (capturedInvalid.get(id) ?? []).filter((test) =>
    Object.keys(test).every((key) => DRIVABLE_CASE_KEYS.has(key)),
  );

  if (drivable.length === 0) {
    failures.push(
      `"${id}" has no probe: no PROBES entry in ${GATE_FILE}, and no invalid fixture case the root config ` +
        `can reproduce. Nothing proves the root config enables it.`,
    );
    continue;
  }

  probes.set(
    id,
    drivable.map((test) => String(test.code)),
  );
}

const pluginNames = new Set(pluginDirs);

const probeDir = mkdtempSync(join(tmpdir(), "warden-oxlint-plugins-"));

const driven = [];

let probeFiles = 0;

try {
  for (const [id, snippets] of probes) {
    snippets.forEach((snippet, index) => {
      writeFileSync(join(probeDir, `${id.replace("/", "__")}__${index}.ts`), snippet);
      probeFiles += 1;
    });
  }

  writeFileSync(join(probeDir, `${CONTROL_NAME}.ts`), CONTROL);

  let stdout;

  try {
    stdout = execFileSync(OXLINT_BIN, ["--config", CONFIG_FILE, "--format", "json", probeDir], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stdout = capturedStdout(error);
  }

  let report;

  try {
    report = JSON.parse(stdout.slice(stdout.indexOf("{")));
  } catch {
    failures.push(
      `oxlint did not emit a JSON report for the probe directory, so no rule was driven. Output was: ` +
        `${stdout.slice(0, 400) || "(empty)"}`,
    );
    report = { diagnostics: [] };
  }

  /** @type {Map<string, { id: string, severity: string }[]>} */
  const reports = new Map();

  for (const diagnostic of report.diagnostics ?? []) {
    const code = /^([a-z0-9-]+)\(([a-z0-9-]+)\)$/.exec(String(diagnostic.code ?? ""));

    if (code === null || !pluginNames.has(code[1])) continue;

    const stem =
      String(diagnostic.filename ?? "")
        .split("/")
        .pop()
        ?.replace(/\.ts$/, "") ?? "";
    const seen = reports.get(stem) ?? [];

    seen.push({ id: `${code[1]}/${code[2]}`, severity: String(diagnostic.severity ?? "") });
    reports.set(stem, seen);
  }

  for (const [id, snippets] of probes) {
    /** @type {number[]} */
    const missed = [];
    /** @type {string[]} */
    const wrongSeverities = [];

    snippets.forEach((_snippet, index) => {
      const own = (reports.get(`${id.replace("/", "__")}__${index}`) ?? []).filter(
        (entry) => entry.id === id,
      );

      if (own.length === 0) {
        missed.push(index);
        return;
      }

      for (const entry of own) {
        if (entry.severity !== "error") wrongSeverities.push(entry.severity);
      }
    });

    if (missed.length > 0) {
      failures.push(
        `The root config did not report ${id} on ${missed.length} of ${snippets.length} probe(s) that violate ` +
          `it (probe ${missed.join(", ")}). It is set to "error" but NOT enforced. Check "jsPlugins" in ` +
          `${CONFIG_FILE}.`,
      );
    } else if (wrongSeverities.length > 0) {
      failures.push(`${id} reported at "${wrongSeverities[0]}", not "error".`);
    } else {
      driven.push(id);
    }
  }

  const controlHits = reports.get(CONTROL_NAME) ?? [];

  if (controlHits.length > 0) {
    failures.push(
      `The control snippet, which violates none of these rules, was reported by ` +
        `${controlHits.map((entry) => entry.id).join(", ")}. A rule that reports everything would satisfy ` +
        `every probe, so the drive proves nothing until this is clean.`,
    );
  }
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("The oxlint plugins are not fully wired:\n");

  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

console.log(
  `check-oxlint-plugin: ${rules.length} rule(s) in ${pluginDirs.length} plugin(s); ${suitesRun} fixture ` +
    `suite(s) pass (${casesRun} case(s)); ${driven.length} driven at "error" through ${CONFIG_FILE} over ` +
    `${probeFiles} probe file(s), control clean; ${queued.length} "off" in the ratchet queue` +
    (queued.length > 0 ? ` (${queued.join(", ")})` : "") +
    `.`,
);
