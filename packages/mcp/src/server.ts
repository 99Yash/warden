import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ZodType, z } from "zod";
import {
  TOOL_NAME_LOOKUP_TYPE_DEF,
  TOOL_NAME_RUN_DET_PRIORS,
  degrade,
  errorEnvelope,
  toolResultEnvelopeSchema,
} from "./envelope.js";
import {
  LookupTypeDefInputSchema,
  LookupTypeDefResultSchema,
  runLookupTypeDef,
} from "./tools/lookup-type-def.js";
import {
  RunDetPriorsInputSchema,
  RunDetPriorsResultSchema,
  runRunDetPriors,
} from "./tools/run-det-priors.js";
import { createReviewResultCache, type ReviewResultCache } from "./review-cache.js";

/**
 * Warden's MCP server — ADR-0053 §2/§3.
 *
 * Transport and tool descriptors live in this package so `@warden/core` stays
 * I/O-pure and free of any MCP dependency (ADR-0013). The server is a *wrapper
 * client of core*, exactly like `@warden/cli` — it consumes exported functions
 * and adds a protocol boundary, nothing more.
 *
 * Scope for this slice is deliberately one tool. MCP tool schemas are injected
 * into the client's context window, so the surface stays small until there is
 * a reason to grow it (ADR-0053 §5a).
 */

export const MCP_SERVER_NAME = "warden";
// keep in sync with package.json — hardcoded, matching how the CLI hardcodes
// its own `.version("0.0.1")` in packages/cli/src/index.ts.
export const MCP_SERVER_VERSION = "0.0.1";

/**
 * Tool descriptors. Kept as data rather than inline closures in the dispatch
 * handler so the advertised schema and the handler cannot drift — one source,
 * two projections.
 *
 * A function of the review cache rather than a module constant, because
 * `run_det_priors` needs per-server retention to page findings. The cache is
 * created inside `createMcpServer`, so each server in a process (and each
 * process) gets its own — the stdio transport is one server per child.
 */
function toolDefinitions(reviewCache: ReviewResultCache) {
  return [
  {
    name: TOOL_NAME_LOOKUP_TYPE_DEF,
    description:
      "Resolve an exported symbol's TypeScript declaration from an installed package's .d.ts files. " +
      "Returns the signature, kind, JSDoc, file and line range, plus a pre-shaped `suggestedSource` " +
      "citation to copy verbatim. Use before claiming an API's shape — this is ground truth, not a guess. " +
      "A negative result is a complete answer, not a failure: branch on the returned `reason`.",
    inputSchema: LookupTypeDefInputSchema,
    resultSchema: toolResultEnvelopeSchema(
      LookupTypeDefResultSchema,
      z.literal(TOOL_NAME_LOOKUP_TYPE_DEF),
    ),
    handler: runLookupTypeDef,
  },
  {
    name: TOOL_NAME_RUN_DET_PRIORS,
    description:
      "Run Warden's Phase 1 deterministic review (tsc, eslint, jscpd, security, consistency, " +
      "scalability, deadcode, leverage, react-doctor) over a review target and return the pruned " +
      "changed-file set, the findings with their tier/category and verified citations, context " +
      "locators, and any degraded runners. This is ground truth, not a guess — a clean result is a " +
      "real answer. Results are size-bounded per component: `findings` holds one page and " +
      "`findingsTotal`/`nextOffset` page the rest, and `omissions` names anything capped. " +
      "Changed files carry `addedLineCount`, never the raw line list. Call again with `offset` to " +
      "continue paging; the server retains the result for the session.",
    inputSchema: RunDetPriorsInputSchema,
    resultSchema: toolResultEnvelopeSchema(
      RunDetPriorsResultSchema,
      z.literal(TOOL_NAME_RUN_DET_PRIORS),
    ),
    handler: (root: string, args: unknown) => runRunDetPriors(root, args, { cache: reviewCache }),
  },
  ] as const;
}

/**
 * Convert a tool's zod input schema to the JSON Schema MCP advertises.
 *
 * `Tool.inputSchema` is a plain JSON Schema object (the SDK validates listings
 * against `ToolSchema`, which types `inputSchema` as `{ type: "object", … }`) —
 * it does *not* accept a zod raw shape the way older SDK versions did. Zod 4
 * ships `z.toJSONSchema` natively, so this needs no extra dependency and no
 * vendored converter.
 *
 * `io: "input"` is the correct direction: what the *model* must send. Using the
 * output direction would advertise the response shape as the request shape.
 * `$schema` is dropped because MCP clients do not expect it in a tool schema.
 */
function toInputJsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return rest as Record<string, unknown>;
}

function toOutputJsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "output" });
  return rest as Record<string, unknown>;
}

export interface StartMcpServerOptions {
  /** Repository root the tools resolve against. Defaults to the launch cwd. */
  repoRoot?: string;
}

/**
 * Server with an in-flight tracker. `whenIdle` resolves once no registered
 * request handler is running; used by `startMcpServer` to let already-started
 * requests finish (and write their responses) before closing on client EOF.
 */
export interface WardenMcpServer extends Server {
  whenIdle(): Promise<void>;
}

export function createMcpServer(repoRoot: string): WardenMcpServer {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  // Bounded, session-scoped retention so `run_det_priors` can page findings
  // without re-running tsc/eslint/jscpd per page. See review-cache.ts.
  const reviewCache = createReviewResultCache();
  const tools = toolDefinitions(reviewCache);
  let inFlight = 0;
  const idleWaiters: Array<() => void> = [];
  const trackedHandler = <Args extends unknown[], Result>(
    fn: (...args: Args) => Promise<Result>,
  ): ((...args: Args) => Promise<Result>) => {
    return async (...args: Args): Promise<Result> => {
      inFlight++;
      try {
        return await fn(...args);
      } finally {
        inFlight--;
        if (inFlight === 0) {
          for (const wake of idleWaiters.splice(0)) wake();
        }
      }
    };
  };
  const whenIdle = (): Promise<void> =>
    inFlight === 0 ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r));

  server.setRequestHandler(ListToolsRequestSchema, trackedHandler(async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toInputJsonSchema(tool.inputSchema),
      // MCP requires an object root. The union validates the *full envelope*,
      // not bare success data; structuredContent below mirrors the JSON text.
      outputSchema: { type: "object" as const, ...toOutputJsonSchema(tool.resultSchema) },
    })),
  })));

  server.setRequestHandler(CallToolRequestSchema, trackedHandler(async (request) => {
    const name = request.params.name;
    const tool = tools.find((t) => t.name === name);
    return degrade(
      name,
      async () => {
        if (tool === undefined) {
          // An unknown tool name is a client error, not a degraded result — but it
          // still returns an envelope rather than a protocol throw, so a client
          // that probes for an optional tool degrades instead of erroring out.
          return errorEnvelope(
            name,
            "invalid_input",
            `Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(", ")}.`,
          );
        }

        return await tool.handler(repoRoot, request.params.arguments);
      },
      tool?.resultSchema,
    );
  }));

  return Object.assign(server, { whenIdle });
}

/**
 * Start the server on stdio and resolve when the serving session ends.
 *
 * One lifetime owner: explicit `server.close()`, the transport's self-close
 * after a read-buffer failure, and the client-EOF path below all fan through
 * `server.onclose`, so `sessionClosed` is the single completion signal.
 *
 * Client EOF is the one terminal path the SDK does not surface: against the
 * installed `@modelcontextprotocol/sdk@1.32.0`, `StdioServerTransport.start()`
 * subscribes stdin to `data`/`error` only (packages/mcp/node_modules/
 * @modelcontextprotocol/sdk/dist/esm/server/stdio.js:32-39), so stdin `end`
 * never reaches `onclose`. On EOF we therefore wait for already-started
 * request handlers to settle (`server.whenIdle()`) — closing first would
 * abort them, since `Protocol._onclose` aborts every in-flight request
 * controller (shared/protocol.js, "Abort all in-flight request handlers"
 * block in `_onclose`) and a handler whose signal aborted never writes its
 * response — and only then close the server. After `close()`, stdin
 * listeners are removed and paused (server/stdio.js:54-67), so nothing
 * else keeps the event loop alive and the process exits naturally unless
 * the caller holds a referenced resource.
 *
 * Verified this session with the real CLI: a cold `lookup_type_def` issued
 * immediately before hanging up still writes its full response and then the
 * child exits 0.
 */
export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const server = createMcpServer(repoRoot);
  const transport = new StdioServerTransport();
  const sessionClosed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  try {
    await server.connect(transport);
  } catch (err) {
    // connect() assigns the transport and installs its callbacks before
    // awaiting transport.start() (shared/protocol.js:219-250), so on failure
    // the transport may already hold stdin listeners — close it explicitly
    // to remove them, then surface the real failure.
    await transport.close().catch(() => {});
    throw err;
  }

  const stdinEnded = new Promise<void>((resolve) => {
    let settled = false;
    const once = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    process.stdin.once("end", once);
    process.stdin.once("close", once);
  });

  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  await Promise.race([
    sessionClosed,
    stdinEnded
      // Let the message dispatch that the final data chunk may have queued
      // (SDK handlers start on a microtask after 'data') reach whenIdle,
      // and, after the last handler settles, give the SDK's own post-handler
      // continuation (result validation + stdout write, also microtasks) one
      // macrotask before close() aborts the request's transport.
      .then(() => tick())
      .then(() => server.whenIdle())
      .then(() => tick())
      .then(() => server.close().catch(() => {})),
  ]);
  await sessionClosed;
}
