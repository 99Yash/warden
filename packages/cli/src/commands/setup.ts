import {
  WARDEN_ENV_FILE_ENV,
  computeReadiness,
  ensureGlobalSetupFiles,
  ensureProjectConfig,
  loadWardenRuntime,
  type CommandReadiness,
  type ProviderReadiness,
  type SetupFileResult,
  type WardenRuntime,
} from "@warden/env";
import pc from "picocolors";

export interface SetupCliOpts {
  check?: boolean;
  json?: boolean;
  project?: boolean;
}

export async function runSetupCommand(opts: SetupCliOpts, repoRoot: string): Promise<void> {
  const global = opts.check ? [] : (await ensureGlobalSetupFiles()).files;
  const project = !opts.check && opts.project ? await ensureProjectConfig(repoRoot) : undefined;
  const runtime = loadWardenRuntime({ repoRoot });
  const readiness = computeReadiness(runtime);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          wrote: { global, project },
          config: {
            globalConfigPath: runtime.globalConfigPath,
            globalEnvPath: runtime.globalEnvPath,
            projectConfigPath: runtime.projectConfigPath,
            repoRoot: runtime.repoRoot,
          },
          envFiles: runtime.envFiles.map((file) => ({
            path: file.path,
            exists: file.exists,
            source: file.source,
            keyCount: file.keys.length,
            ...(file.error ? { error: file.error } : {}),
          })),
          readiness,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  renderSetup({ global, project, runtime, readiness });
}

function renderSetup(input: {
  global: SetupFileResult[];
  project?: { path: string; status: "created" | "exists" };
  runtime: WardenRuntime;
  readiness: ReturnType<typeof computeReadiness>;
}): void {
  process.stdout.write(pc.bold("Warden setup\n"));

  if (input.global.length > 0) {
    process.stdout.write("\n" + pc.bold("Files") + "\n");
    for (const file of input.global) {
      const mode = file.mode ? ` ${pc.dim(`mode ${file.mode}`)}` : "";
      process.stdout.write(`  ${statusIcon(file.status)} ${file.path}${mode}\n`);
    }
  }

  if (input.project) {
    process.stdout.write(`  ${statusIcon(input.project.status)} ${input.project.path}\n`);
  }

  process.stdout.write("\n" + pc.bold("Env Lookup") + "\n");
  process.stdout.write(`  process env\n`);
  for (const file of input.runtime.envFiles) {
    const detail = file.exists
      ? `${file.keys.length} key${file.keys.length === 1 ? "" : "s"}`
      : "missing";
    const error = file.error ? pc.red(` (${file.error})`) : "";
    process.stdout.write(`  ${file.exists ? "✓" : "·"} ${file.path} ${pc.dim(detail)}${error}\n`);
  }
  process.stdout.write(`  ${pc.dim(`${WARDEN_ENV_FILE_ENV} can point at a one-off env file.`)}\n`);

  process.stdout.write("\n" + pc.bold("Providers") + "\n");
  for (const provider of input.readiness.providers) {
    process.stdout.write(`  ${providerIcon(provider)} ${formatProvider(provider)}\n`);
  }

  process.stdout.write("\n" + pc.bold("Commands") + "\n");
  for (const command of input.readiness.commands) {
    process.stdout.write(
      `  ${command.ready ? pc.green("✓") : pc.yellow("!")} ${formatCommand(command)}\n`,
    );
  }

  const missing = missingEnvNames(input.readiness.commands);
  if (missing.length > 0) {
    process.stdout.write("\n" + pc.bold("Next") + "\n");
    process.stdout.write(
      `  Add missing provider keys to ${input.runtime.globalEnvPath}, export them in your shell,\n`,
    );
    process.stdout.write(`  or run Warden through your secret manager, for example:\n`);
    process.stdout.write(`  ${pc.dim("infisical run -- warden review")}\n`);
  }
}

function statusIcon(status: SetupFileResult["status"] | "exists" | "created"): string {
  if (status === "created") return pc.green("created");
  if (status === "fixed-permissions") return pc.yellow("fixed");
  return pc.dim("exists");
}

function providerIcon(provider: ProviderReadiness): string {
  if (provider.configured) return pc.green("✓");
  if (provider.requiredFor.length > 0) return pc.yellow("!");
  return pc.dim("·");
}

function formatProvider(provider: ProviderReadiness): string {
  const required =
    provider.requiredFor.length > 0 ? ` required: ${provider.requiredFor.join(", ")}` : "";
  const optional =
    provider.optionalFor.length > 0 ? ` optional: ${provider.optionalFor.join(", ")}` : "";
  const source = provider.source
    ? provider.source.source === "file"
      ? ` via ${provider.source.path}`
      : " via process env"
    : "";
  const readiness = provider.configured ? pc.green("configured") : pc.yellow("missing");
  return `${provider.id} ${pc.dim(provider.kind)} ${provider.apiKeyEnv} ${readiness}${source}${required}${optional}`;
}

function formatCommand(command: CommandReadiness): string {
  if (command.ready) return `${command.command} ${pc.green("ready")}`;
  return `${command.command} ${pc.yellow(`missing ${command.missing.join(", ")}`)}`;
}

function missingEnvNames(commands: CommandReadiness[]): string[] {
  return [
    ...new Set(
      commands
        .flatMap((command) => command.missing)
        .filter((name) => !name.startsWith("provider:")),
    ),
  ];
}
