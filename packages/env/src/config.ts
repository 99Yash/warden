import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const WARDEN_CONFIG_SCHEMA_URL = "https://wrdn.beauty/schema/config.json";
export const WARDEN_PROJECT_CONFIG = "warden.jsonc";
export const WARDEN_ENV_FILE_ENV = "WARDEN_ENV_FILE";

const STARTUP_ENV_KEYS = new Set(Object.keys(process.env));

const envNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name");

const providerSchema = z
  .object({
    kind: z.enum(["llm", "embedding"]),
    apiKeyEnv: envNameSchema,
  })
  .strict();

const configSchema = z
  .object({
    $schema: z.string().optional(),
    env: z
      .object({
        files: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    providers: z.record(z.string(), providerSchema).optional(),
    routing: z
      .object({
        llm: z
          .object({
            primary: z.string().optional(),
            fallback: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        embeddings: z
          .object({
            primary: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    modelPolicy: z
      .object({
        profile: z.literal("standard").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WardenConfig = z.infer<typeof configSchema>;
export type WardenProviderConfig = z.infer<typeof providerSchema>;

export type ConfigLayerKind = "defaults" | "global" | "project";

export interface ConfigLayer {
  kind: ConfigLayerKind;
  path?: string;
  baseDir: string;
  config: WardenConfig;
}

export interface LoadedEnvFile {
  path: string;
  exists: boolean;
  source: "config" | "project" | "builtin-project" | "override";
  keys: string[];
  error?: string;
}

export interface EnvVarSource {
  envName: string;
  source: "process" | "file";
  path?: string;
}

export interface WardenRuntime {
  config: WardenConfig;
  layers: ConfigLayer[];
  envFiles: LoadedEnvFile[];
  envSources: Map<string, EnvVarSource>;
  repoRoot?: string;
  globalConfigPath: string;
  globalEnvPath: string;
  projectConfigPath?: string;
}

export interface SetupFileResult {
  path: string;
  status: "created" | "exists" | "fixed-permissions";
  mode?: string;
}

export interface GlobalSetupResult {
  files: SetupFileResult[];
}

export interface ProjectSetupResult {
  path: string;
  status: "created" | "exists";
}

let runtime: WardenRuntime | undefined;

export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "warden");
}

export function globalConfigPath(): string {
  return path.join(globalConfigDir(), "config.jsonc");
}

export function globalEnvPath(): string {
  return path.join(globalConfigDir(), "env");
}

export function defaultWardenConfig(): WardenConfig {
  return {
    $schema: WARDEN_CONFIG_SCHEMA_URL,
    env: {
      files: [globalEnvPath()],
    },
    providers: {
      anthropic: {
        kind: "llm",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      google: {
        kind: "llm",
        apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
      },
      voyage: {
        kind: "embedding",
        apiKeyEnv: "VOYAGE_API_KEY",
      },
    },
    routing: {
      llm: {
        primary: "anthropic",
        fallback: ["google"],
      },
      embeddings: {
        primary: "voyage",
      },
    },
    modelPolicy: {
      profile: "standard",
    },
  };
}

export function loadWardenRuntime(opts: { repoRoot?: string } = {}): WardenRuntime {
  const resolvedRepoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : undefined;
  const layers = loadConfigLayers(resolvedRepoRoot);
  const merged = layers.reduce<WardenConfig>(
    (acc, layer) => mergeConfig(acc, layer.config),
    {},
  );
  const envFiles = collectEnvFiles(layers, resolvedRepoRoot);
  const envSources = loadEnvFiles(envFiles);
  runtime = {
    config: merged,
    layers,
    envFiles,
    envSources,
    ...(resolvedRepoRoot ? { repoRoot: resolvedRepoRoot } : {}),
    globalConfigPath: globalConfigPath(),
    globalEnvPath: globalEnvPath(),
    ...(resolvedRepoRoot
      ? { projectConfigPath: path.join(resolvedRepoRoot, WARDEN_PROJECT_CONFIG) }
      : {}),
  };
  return runtime;
}

export function currentWardenRuntime(opts: { repoRoot?: string } = {}): WardenRuntime {
  if (!runtime || (opts.repoRoot && path.resolve(opts.repoRoot) !== runtime.repoRoot)) {
    return loadWardenRuntime(opts);
  }
  return runtime;
}

export function getProviderConfig(providerId: string): WardenProviderConfig | undefined {
  return currentWardenRuntime().config.providers?.[providerId];
}

export function configuredLlmPrimaryProvider(): string {
  return currentWardenRuntime().config.routing?.llm?.primary ?? "anthropic";
}

export function configuredLlmFallbackProviders(): string[] {
  return currentWardenRuntime().config.routing?.llm?.fallback ?? [];
}

export function configuredEmbeddingProvider(): string {
  return currentWardenRuntime().config.routing?.embeddings?.primary ?? "voyage";
}

export function providerApiKey(providerId: string): string | undefined {
  const provider = getProviderConfig(providerId);
  if (!provider) return undefined;
  const value = process.env[provider.apiKeyEnv];
  return value && value.length > 0 ? value : undefined;
}

export function requireProviderApiKey(providerId: string, command: string): string {
  const runtimeInfo = currentWardenRuntime();
  const provider = runtimeInfo.config.providers?.[providerId];
  if (!provider) {
    throw new Error(`Provider "${providerId}" is not configured for ${command}.`);
  }
  const value = process.env[provider.apiKeyEnv];
  if (value && value.length > 0) return value;
  throw new Error(formatMissingEnvMessage(provider.apiKeyEnv, command, runtimeInfo));
}

export function envVarSource(envName: string): EnvVarSource | undefined {
  return envVarSourceFromRuntime(currentWardenRuntime(), envName);
}

export function isProviderConfigured(providerId: string): boolean {
  return providerApiKey(providerId) !== undefined;
}

export interface ProviderReadiness {
  id: string;
  kind: "llm" | "embedding";
  apiKeyEnv: string;
  requiredFor: string[];
  optionalFor: string[];
  configured: boolean;
  source?: EnvVarSource;
}

export interface CommandReadiness {
  command: "check" | "review" | "init";
  ready: boolean;
  missing: string[];
}

export interface WardenReadiness {
  providers: ProviderReadiness[];
  commands: CommandReadiness[];
}

export function computeReadiness(info: WardenRuntime = currentWardenRuntime()): WardenReadiness {
  const primary = info.config.routing?.llm?.primary ?? "anthropic";
  const fallbacks = new Set(info.config.routing?.llm?.fallback ?? []);
  const embedding = info.config.routing?.embeddings?.primary ?? "voyage";
  const providers = Object.entries(info.config.providers ?? {}).map(([id, provider]) => {
    const source = envVarSourceFromRuntime(info, provider.apiKeyEnv);
    return {
      id,
      kind: provider.kind,
      apiKeyEnv: provider.apiKeyEnv,
      requiredFor: requiredForProvider(id, primary, embedding),
      optionalFor: fallbacks.has(id) ? ["review fallback"] : [],
      configured: source !== undefined,
      ...(source ? { source } : {}),
    };
  });
  const reviewMissing = missingForProvider(primary, info);
  const initMissing = missingForProvider(embedding, info);
  return {
    providers,
    commands: [
      { command: "check", ready: true, missing: [] },
      { command: "review", ready: reviewMissing.length === 0, missing: reviewMissing },
      { command: "init", ready: initMissing.length === 0, missing: initMissing },
    ],
  };
}

function envVarSourceFromRuntime(info: WardenRuntime, envName: string): EnvVarSource | undefined {
  const fileSource = info.envSources.get(envName);
  if (fileSource) return fileSource;
  const value = process.env[envName];
  if (value && value.length > 0) return { envName, source: "process" };
  return undefined;
}

export async function ensureGlobalSetupFiles(): Promise<GlobalSetupResult> {
  const dir = globalConfigDir();
  const configPath = globalConfigPath();
  const envPath = globalEnvPath();
  const files: SetupFileResult[] = [];
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmodIfNeeded(dir, 0o700);

  if (!existsSync(configPath)) {
    await writeFile(configPath, defaultConfigTemplate(), { mode: 0o644 });
    files.push({ path: configPath, status: "created", mode: "0644" });
  } else {
    files.push({ path: configPath, status: "exists" });
  }

  if (!existsSync(envPath)) {
    await writeFile(envPath, defaultEnvTemplate(), { mode: 0o600 });
    files.push({ path: envPath, status: "created", mode: "0600" });
  } else if (await chmodIfNeeded(envPath, 0o600)) {
    files.push({ path: envPath, status: "fixed-permissions", mode: "0600" });
  } else {
    files.push({ path: envPath, status: "exists" });
  }

  return { files };
}

export async function ensureProjectConfig(repoRoot: string): Promise<ProjectSetupResult> {
  const file = path.join(repoRoot, WARDEN_PROJECT_CONFIG);
  if (!existsSync(file)) {
    await writeFile(file, projectConfigTemplate(), { mode: 0o644 });
    return { path: file, status: "created" };
  }
  return { path: file, status: "exists" };
}

export function defaultConfigTemplate(): string {
  return `${JSON.stringify(defaultWardenConfig(), null, 2)}\n`;
}

export function defaultEnvTemplate(): string {
  return `# Warden provider secrets
# Secrets can also come from your shell, Infisical, Doppler, 1Password, CI, etc.

# Required for \`warden review\`
# ANTHROPIC_API_KEY=sk-ant-...

# Optional fallback for \`warden review\`
# GOOGLE_GENERATIVE_AI_API_KEY=...

# Required for \`warden init\`
# VOYAGE_API_KEY=pa-...
`;
}

export function projectConfigTemplate(): string {
  return `{
  "$schema": "${WARDEN_CONFIG_SCHEMA_URL}",
  "modelPolicy": {
    "profile": "standard"
  }
}
`;
}

function loadConfigLayers(repoRoot: string | undefined): ConfigLayer[] {
  const layers: ConfigLayer[] = [
    {
      kind: "defaults",
      baseDir: globalConfigDir(),
      config: defaultWardenConfig(),
    },
  ];
  const globalPath = globalConfigPath();
  if (existsSync(globalPath)) {
    layers.push(loadConfigFile("global", globalPath));
  }
  if (repoRoot) {
    const projectPath = path.join(repoRoot, WARDEN_PROJECT_CONFIG);
    if (existsSync(projectPath)) {
      layers.push(loadConfigFile("project", projectPath));
    }
  }
  return layers;
}

function loadConfigFile(kind: "global" | "project", file: string): ConfigLayer {
  const raw = readFileSyncUtf8(file);
  const parsed = parseJsonc(raw, file);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid Warden config at ${file}:\n${formatted}`);
  }
  return {
    kind,
    path: file,
    baseDir: path.dirname(file),
    config: result.data,
  };
}

function readFileSyncUtf8(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function collectEnvFiles(layers: ConfigLayer[], repoRoot: string | undefined): LoadedEnvFile[] {
  const files: LoadedEnvFile[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    for (const raw of layer.config.env?.files ?? []) {
      const resolved = resolveConfigPath(raw, layer.baseDir);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      files.push({
        path: resolved,
        exists: existsSync(resolved),
        source: layer.kind === "project" ? "project" : "config",
        keys: [],
      });
    }
  }
  if (repoRoot) {
    for (const name of [".env", ".env.local"]) {
      const resolved = path.join(repoRoot, name);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      files.push({
        path: resolved,
        exists: existsSync(resolved),
        source: "builtin-project",
        keys: [],
      });
    }
  }
  const override = process.env[WARDEN_ENV_FILE_ENV];
  if (override && override.trim()) {
    const resolved = resolveConfigPath(override, process.cwd());
    if (!seen.has(resolved)) {
      files.push({
        path: resolved,
        exists: existsSync(resolved),
        source: "override",
        keys: [],
      });
    }
  }
  return files;
}

function loadEnvFiles(files: LoadedEnvFile[]): Map<string, EnvVarSource> {
  const sources = new Map<string, EnvVarSource>();
  for (const file of files) {
    if (!file.exists) continue;
    try {
      const text = readFileSyncUtf8(file.path);
      const entries = parseEnv(text);
      file.keys = Object.keys(entries);
      for (const [key, value] of Object.entries(entries)) {
        if (STARTUP_ENV_KEYS.has(key) && (process.env[key]?.length ?? 0) > 0) continue;
        process.env[key] = value;
        sources.set(key, { envName: key, source: "file", path: file.path });
      }
    } catch (err) {
      file.error = formatErr(err);
    }
  }
  return sources;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const rawValue = withoutExport.slice(eq + 1).trim();
    out[key] = parseEnvValue(rawValue);
  }
  return out;
}

function parseEnvValue(raw: string): string {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0] as '"' | "'";
    const end = findClosingEnvQuote(raw, quote);
    if (end !== -1) {
      const inner = raw.slice(1, end);
      return quote === '"'
        ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"')
        : inner;
    }
  }
  return raw.replace(/\s+#.*$/, "");
}

function findClosingEnvQuote(raw: string, quote: '"' | "'"): number {
  for (let i = 1; i < raw.length; i++) {
    const char = raw[i];
    if (quote === '"' && char === "\\") {
      i++;
      continue;
    }
    if (char === quote) return i;
  }
  return -1;
}

function parseJsonc(text: string, source: string): unknown {
  try {
    return JSON.parse(removeTrailingCommas(stripJsonComments(text)));
  } catch (err) {
    throw new Error(`Failed to parse JSONC at ${source}: ${formatErr(err)}`);
  }
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const n = text[i + 1] ?? "";
    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        out += c;
      }
      continue;
    }
    if (blockComment) {
      if (c === "*" && n === "/") {
        blockComment = false;
        i++;
      } else if (c === "\n") {
        out += "\n";
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      blockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (inString) {
      out += c;
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      const next = text[j];
      if (next === "}" || next === "]") continue;
    }
    out += c;
  }
  return out;
}

function mergeConfig(base: WardenConfig, override: WardenConfig): WardenConfig {
  return deepMerge(base, override) as WardenConfig;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(merged[key], value);
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigPath(raw: string, baseDir: string): string {
  const expanded = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function missingForProvider(providerId: string, info: WardenRuntime): string[] {
  const provider = info.config.providers?.[providerId];
  if (!provider) return [`provider:${providerId}`];
  return process.env[provider.apiKeyEnv] ? [] : [provider.apiKeyEnv];
}

function requiredForProvider(id: string, primary: string, embedding: string): string[] {
  const required: string[] = [];
  if (id === primary) required.push("review");
  if (id === embedding) required.push("init");
  return required;
}

function formatMissingEnvMessage(envName: string, command: string, info: WardenRuntime): string {
  const checked = info.envFiles.map((file) => `  ${file.path}${file.exists ? "" : " (missing)"}`);
  return [
    `${command} needs ${envName}`,
    "",
    "Checked:",
    "  process env",
    ...checked,
    "",
    `Add ${envName} to ${info.globalEnvPath}, export it in your shell, or run through your secret manager:`,
    `  infisical run -- ${command}`,
  ].join("\n");
}

async function chmodIfNeeded(target: string, wanted: number): Promise<boolean> {
  if (process.platform === "win32") return false;
  const current = await stat(target);
  if ((current.mode & 0o777) === wanted) return false;
  await chmod(target, wanted);
  return true;
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
