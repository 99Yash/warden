/**
 * Slice #39 / ADR-0053: speak real MCP over stdio against `warden mcp`.
 * Uses the installed TypeScript declarations and a fresh, isolated cache so
 * an existing DB cannot hide a missing auto-migration on the server path.
 *
 * Usage: pnpm --filter @warden/cli smoke:mcp-server
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  LookupTypeDefResultSchema,
  MAX_TOOL_RESULT_BYTES,
  TOOL_ENVELOPE_VERSION,
  TOOL_ERROR_REASONS,
  ToolResultEnvelopeSchema,
  degrade,
  okEnvelope,
  toolResultEnvelopeSchema,
} from "@warden/mcp";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), "warden-mcp-server-"));
const CACHE_PATH = resolve(TMP_ROOT, ".warden/cache.sqlite");
const SYMBOL = "ts.createSourceFile";
const MISSING_SYMBOL = "ts.__warden_missing_symbol__";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

const client = new Client({ name: "warden-mcp-smoke", version: "0.0.1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", import.meta.resolve("tsx/esm"), resolve(CLI_ROOT, "src/index.ts"), "mcp"],
  cwd: TMP_ROOT,
  env: { ...getDefaultEnvironment(), WARDEN_CACHE_PATH: CACHE_PATH },
  stderr: "pipe",
});
let stderr = "";
const protocolErrors: string[] = [];
transport.stderr?.on("data", (chunk) => {
  stderr += String(chunk);
});
client.onerror = (err) => {
  protocolErrors.push(err.message);
};

async function call(name: string, args: Record<string, unknown>, caller: Client = client) {
  const result = CallToolResultSchema.parse(await caller.callTool({ name, arguments: args }));
  const content = result.content;
  if (content.length !== 1 || content[0]?.type !== "text") {
    throw new Error(`Expected one JSON text block from ${name}`);
  }
  if (Buffer.byteLength(content[0].text, "utf8") > MAX_TOOL_RESULT_BYTES) {
    throw new Error(`${name} exceeded the tool-content byte limit`);
  }
  const envelope = ToolResultEnvelopeSchema.parse(JSON.parse(content[0].text));
  const expectedError =
    envelope.status === "error" &&
    !["symbol_not_found", "no_types", "package_not_installed"].includes(envelope.reason);
  assert(
    result.isError === expectedError,
    `${name} isError is ${expectedError} for ${envelope.status === "ok" ? "success" : envelope.reason}`,
  );
  assert(
    JSON.stringify(result.structuredContent) === JSON.stringify(JSON.parse(content[0].text)),
    `${name} preserves the full envelope in structuredContent and JSON text`,
  );
  // tautology-ok: partial correlation, not serialization-only. The version
  // assertion repeats the shared envelope schema's literal check (the parse
  // above already rejects a wrong version), and the tool-name assertion
  // checks request/result correlation — it fails if the handler returns an
  // envelope built for a different tool than the one requested, even though
  // JSON-RPC transmitted every field faithfully.
  assert(envelope.envelopeVersion === TOOL_ENVELOPE_VERSION, `${name} envelope is versioned`);
  assert(envelope.tool === name, `${name} envelope identifies the tool`);
  return envelope;
}

try {
  // Resolver searches node_modules at repoRoot, not the CLI's source location.
  // Symlink the real TypeScript install into the isolated repository fixture.
  writeFileSync(resolve(TMP_ROOT, "package.json"), JSON.stringify({ name: "warden-mcp-smoke" }));
  mkdirSync(resolve(TMP_ROOT, "node_modules"));
  symlinkSync(
    resolve(CLI_ROOT, "node_modules/typescript"),
    resolve(TMP_ROOT, "node_modules/typescript"),
    "dir",
  );
  const oversizedPackage = resolve(TMP_ROOT, "node_modules/warden-oversized-fixture");
  mkdirSync(oversizedPackage);
  writeFileSync(
    resolve(oversizedPackage, "package.json"),
    JSON.stringify({
      name: "warden-oversized-fixture",
      version: "0.0.1",
      types: "index.d.ts",
    }),
  );
  writeFileSync(
    resolve(oversizedPackage, "index.d.ts"),
    `/** ${"界".repeat(MAX_TOOL_RESULT_BYTES / 2)} */\nexport declare function large(): void;\n`,
  );
  assert(
    readFileSync(resolve(TMP_ROOT, "node_modules/typescript/lib/typescript.d.ts"), "utf8").includes(
      "function createSourceFile(",
    ),
    "known symbol exists in installed TypeScript declarations",
  );
  assert(!existsSync(CACHE_PATH), "server starts with no cache database");

  process.stdout.write("\n[1] MCP — initialize + tools/list\n");
  await client.connect(transport, { timeout: 15_000 });
  const serverPid = transport.pid;
  assert(transport.pid !== null, "server runs in a child process");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert(
    names.length === 2 && names[0] === "lookup_type_def" && names[1] === "run_det_priors",
    `both tools are discovered (${names.join(", ")})`,
  );
  // Selected by name, not index: discovery order is not part of the contract,
  // and index 0 stopped meaning "the lookup tool" once #40 added a second.
  const lookup = tools.find((t) => t.name === "lookup_type_def");
  const schema = lookup?.inputSchema;
  const outputSchema = lookup?.outputSchema;
  assert(outputSchema?.type === "object", "output schema advertises an object envelope");
  assert(
    Array.isArray(outputSchema?.oneOf) &&
      outputSchema.oneOf.length === 2 &&
      outputSchema.oneOf.every(
        (branch) =>
          typeof branch === "object" &&
          branch !== null &&
          "required" in branch &&
          Array.isArray(branch.required) &&
          branch.required.includes("envelopeVersion") &&
          branch.required.includes("tool") &&
          branch.required.includes("status"),
      ),
    "output schema advertises both full envelope branches, not bare lookup data",
  );
  assert(schema?.type === "object", "input schema is a JSON Schema object");
  const packageProperty = schema?.properties?.package;
  const symbolProperty = schema?.properties?.symbol;
  assert(
    packageProperty &&
      "type" in packageProperty &&
      packageProperty.type === "string" &&
      symbolProperty &&
      "type" in symbolProperty &&
      symbolProperty.type === "string",
    "package and symbol are string properties",
  );
  assert(
    schema?.required?.includes("package") && schema?.required?.includes("symbol"),
    "both input properties are required",
  );

  process.stdout.write("\n[2] MCP — known symbol\n");
  const known = await call("lookup_type_def", { package: "typescript", symbol: SYMBOL });
  assert(known.status === "ok", "known symbol returns status: ok");
  const parsed = LookupTypeDefResultSchema.safeParse(known.data);
  assert(parsed.success, "success data matches the lookup result schema");
  if (parsed.success) {
    const data = parsed.data;
    const ss = data.suggestedSource;
    assert(data.found && data.symbol === SYMBOL, "requested symbol resolves");
    assert(
      ss.type === "api_def" &&
        ss.id === `typescript@${data.version}#${SYMBOL}` &&
        ss.title === `function ${SYMBOL}` &&
        ss.path === data.dts_file &&
        ss.line === data.line_start &&
        ss.snippet === data.signature &&
        typeof ss.retrievedAt === "string" &&
        Number.isFinite(Date.parse(ss.retrievedAt)),
      "suggestedSource is a complete pre-shaped api_def citation",
    );
  }
  assert(existsSync(CACHE_PATH), "server creates and auto-migrates the fresh cache");

  process.stdout.write("\n[3] MCP — missing symbol\n");
  const missing = await call("lookup_type_def", { package: "typescript", symbol: MISSING_SYMBOL });
  assert(missing.status === "error", "missing symbol returns status: error");
  assert(
    missing.reason !== undefined && TOOL_ERROR_REASONS.includes(missing.reason),
    "not-found reason belongs to the closed union",
  );
  assert(
    missing.reason === "symbol_not_found",
    "missing symbol returns symbol_not_found, not a DB error",
  );

  process.stdout.write("\n[4] MCP — unknown tool + invalid input\n");
  const unknown = await call("__warden_unknown_tool__", {});
  assert(
    unknown.status === "error" && unknown.reason === "invalid_input",
    "unknown tool returns structured invalid_input",
  );
  const invalid = await call("lookup_type_def", { package: "typescript" });
  assert(
    invalid.status === "error" && invalid.reason === "invalid_input",
    "invalid arguments return structured invalid_input",
  );

  process.stdout.write("\n[5] MCP — bounded results\n");
  const oversized = await call("lookup_type_def", {
    package: "warden-oversized-fixture",
    symbol: "large",
  });
  assert(
    oversized.status === "error" &&
      oversized.reason === "result_too_large" &&
      oversized.data === undefined,
    "oversized result degrades without returning a truncated citation",
  );
  assert(oversized.hint?.includes("content limit"), "overflow envelope explains the size limit");
  assert(
    oversized.hint?.includes("node_modules") && !oversized.hint.includes("narrower symbol"),
    "overflow hint directs a single-symbol lookup to local declarations",
  );

  process.stdout.write("\n[6] MCP — sequential calls after degradation\n");
  // Keep the same child alive through uncached parses and positive/negative
  // cache hits. Later-call native crashes must fail, not be hidden by respawns.
  const sequential = [
    { symbol: "ts.createPrinter", found: true },
    { symbol: "ts.__warden_missing_later_1__", found: false },
    { symbol: "ts.isIdentifier", found: true },
    { symbol: "ts.__warden_missing_later_2__", found: false },
    { symbol: SYMBOL, found: true },
    { symbol: MISSING_SYMBOL, found: false },
  ];
  for (const { symbol, found } of sequential) {
    const result = await call("lookup_type_def", { package: "typescript", symbol });
    if (found) {
      const data = LookupTypeDefResultSchema.safeParse(result.data);
      assert(
        result.status === "ok" && data.success && data.data.symbol === symbol,
        `later lookup resolves ${symbol}`,
      );
    } else {
      assert(
        result.status === "error" && result.reason === "symbol_not_found",
        `later lookup reports symbol_not_found for ${symbol}`,
      );
    }
  }
  assert(
    serverPid !== null && transport.pid === serverPid,
    "same server survives all eleven sequential tools/call requests",
  );

  await client.close();
  process.stdout.write("\n[7] MCP — cache persistence + clean transport\n");
  // Only open in the parent after proving the child created the DB. db() also
  // auto-migrates, so opening it earlier would hide a server initialization bug.
  process.env["WARDEN_CACHE_PATH"] = CACHE_PATH;
  const { closeDb, db, typeDefCache } = await import("@warden/db");
  try {
    const rows = db().select().from(typeDefCache).all();
    assert(
      rows.some((r) => r.package === "typescript" && r.symbol === SYMBOL && r.found),
      "server persists the positive lookup",
    );
    assert(
      rows.some(
        (r) =>
          r.package === "typescript" &&
          r.symbol === MISSING_SYMBOL &&
          r.reason === "symbol_not_found",
      ),
      "server persists the negative lookup",
    );
  } finally {
    closeDb();
  }
  assert(protocolErrors.length === 0, "no protocol errors or non-JSON stdout");

  process.stdout.write("\n[8] MCP — contract validation + serialization degradation\n");
  const common = { envelopeVersion: TOOL_ENVELOPE_VERSION, tool: "lookup_type_def" };
  for (const [label, candidate] of [
    ["success without data", { ...common, status: "ok" }],
    ["error without reason", { ...common, status: "error" }],
    ["mixed error and data", { ...common, status: "error", reason: "internal_error", data: {} }],
    ["mixed success and reason", { ...common, status: "ok", data: {}, reason: "internal_error" }],
  ] as const) {
    assert(!ToolResultEnvelopeSchema.safeParse(candidate).success, `schema rejects ${label}`);
  }
  if (known.status !== "ok") throw new Error("Known lookup required for contract regression");
  const malformedData = { ...known.data, suggestedSource: {} };
  assert(
    !LookupTypeDefResultSchema.safeParse(malformedData).success,
    "lookup schema rejects an empty suggestedSource",
  );
  const malformed = await degrade(
    "lookup_type_def",
    async () => okEnvelope("lookup_type_def", malformedData),
    toolResultEnvelopeSchema(LookupTypeDefResultSchema),
  );
  assert(
    malformed.isError &&
      malformed.structuredContent.status === "error" &&
      malformed.structuredContent.reason === "internal_error",
    "dispatch boundary degrades invalid per-tool success data",
  );
  const thrown = await degrade("lookup_type_def", async () => {
    throw new Error("handler fault");
  });
  assert(
    thrown.isError &&
      thrown.structuredContent.status === "error" &&
      thrown.structuredContent.reason === "internal_error" &&
      thrown.structuredContent.hint === "handler fault",
    "dispatch boundary preserves recovery content for a thrown handler",
  );
  const serialization = await degrade("lookup_type_def", async () =>
    okEnvelope("lookup_type_def", { value: 1n }),
  );
  assert(
    serialization.isError &&
      serialization.structuredContent.status === "error" &&
      serialization.structuredContent.reason === "internal_error",
    "dispatch boundary degrades final JSON serialization failure",
  );
  const alteredWire = await degrade("lookup_type_def", async () =>
    okEnvelope("lookup_type_def", {
      toJSON: () => undefined,
    }),
  );
  assert(
    alteredWire.isError &&
      alteredWire.structuredContent.status === "error" &&
      alteredWire.structuredContent.reason === "internal_error",
    "serialization boundary validates the actual wire envelope after toJSON",
  );

  process.stdout.write("\n[9] MCP — corrupt cache internal_error + repaired-cache retry\n");
  const corruptCache = resolve(TMP_ROOT, "corrupt.sqlite");
  writeFileSync(corruptCache, "not a SQLite database");
  const corruptClient = new Client({ name: "warden-mcp-corrupt-smoke", version: "0.0.1" });
  const corruptTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx/esm"), resolve(CLI_ROOT, "src/index.ts"), "mcp"],
    cwd: TMP_ROOT,
    env: { ...getDefaultEnvironment(), WARDEN_CACHE_PATH: corruptCache },
    stderr: "pipe",
  });
  const corruptErrors: string[] = [];
  corruptClient.onerror = (err) => {
    corruptErrors.push(err.message);
  };
  corruptTransport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await corruptClient.connect(corruptTransport, { timeout: 15_000 });
    await corruptClient.listTools();
    const corruptPid = corruptTransport.pid;
    for (let i = 0; i < 3; i++) {
      const broken = await call(
        "lookup_type_def",
        { package: "typescript", symbol: SYMBOL },
        corruptClient,
      );
      assert(
        broken.status === "error" &&
          broken.reason === "internal_error" &&
          broken.hint?.includes("not a database"),
        `corrupt cache lookup ${i + 1} returns internal_error with recovery content`,
      );
    }
    rmSync(corruptCache, { force: true });
    const repaired = await call(
      "lookup_type_def",
      { package: "typescript", symbol: SYMBOL },
      corruptClient,
    );
    assert(
      repaired.status === "ok" && LookupTypeDefResultSchema.safeParse(repaired.data).success,
      "same server retries successfully after corrupt cache is removed",
    );
    assert(
      corruptPid !== null && corruptTransport.pid === corruptPid,
      "corrupt-cache recovery keeps the same server process",
    );
    assert(corruptErrors.length === 0, "corrupt cache never escapes as a protocol error");
  } finally {
    await corruptClient.close();
  }

  process.stdout.write("\n[10] MCP — EOF drains in-flight work, post-session path runs\n");
  {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx/esm"), resolve(CLI_ROOT, "src/index.ts"), "mcp"],
      {
        cwd: TMP_ROOT,
        env: { ...process.env, WARDEN_CACHE_PATH: CACHE_PATH },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let childOut = "";
    let childErr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      childOut += c;
    });
    child.stderr.on("data", (c: string) => {
      childErr += c;
    });
    const send = (msg: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };
    const waitFor = (id: number, timeoutMs = 10_000): Promise<Record<string, unknown>> =>
      new Promise((resolveWait, rejectWait) => {
        const started = Date.now();
        const poll = (): void => {
          const line = childOut.split("\n").find((l) => {
            try {
              return (JSON.parse(l) as { id?: number }).id === id;
            } catch {
              return false;
            }
          });
          if (line) {
            resolveWait(JSON.parse(line) as Record<string, unknown>);
          } else if (Date.now() - started > timeoutMs) {
            rejectWait(
              new Error(`timeout waiting for response id ${id}; stderr so far: ${childErr}`),
            );
          } else {
            setTimeout(poll, 25);
          }
        };
        poll();
      });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke-eof", version: "0.0.1" },
      },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lookup_type_def",
        arguments: { package: "typescript", symbol: "ts.createProgram" },
      },
    });
    // Hang up immediately: EOF races the in-flight cold lookup. The response
    // must still be written, and only then may the server close.
    child.stdin.end();
    const response = await waitFor(2);
    const parsed = response as { result?: { content?: Array<{ text?: string }> } };
    const textBlock = parsed.result?.content?.[0]?.text;
    let toolEnvelope: { status?: string } | undefined;
    try {
      toolEnvelope = textBlock ? (JSON.parse(textBlock) as { status?: string }) : undefined;
    } catch {
      toolEnvelope = undefined;
    }
    assert(
      toolEnvelope?.status === "ok",
      "in-flight tools/call response is written after client EOF",
    );
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
    });
    assert(exitCode === 0, `child exits 0 after EOF-driven drain (got ${exitCode})`);
    assert(
      childErr.includes("warden mcp: session ended"),
      "post-session continuation runs after EOF (session ended marker on stderr)",
    );
  }
} catch (err) {
  assert(false, `MCP smoke threw: ${err instanceof Error ? err.message : String(err)}`);
  if (stderr) process.stderr.write(stderr);
} finally {
  await client.close();
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall assertions passed\n");
