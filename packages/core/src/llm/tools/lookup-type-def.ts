import * as fs from "node:fs";
import * as path from "node:path";
import { tool } from "@warden/ai";
import { z } from "zod";
import { lookupTypeDef, type LookupTypeDefResult } from "../../api/lookup-type-def.js";
import type { DegradedEntry } from "../../schema.js";

/**
 * M11 (ADR-0026): AI SDK tool descriptor wrapping `lookupTypeDef` for the
 * formatter LLM. Triggered by the four conditions in the formatter system
 * prompt's "Verifying library API claims" section.
 *
 * The descriptor owns the once-per-review "no `node_modules/`" detection.
 * A review with N tool calls into an empty `node_modules/` would emit N
 * degraded entries if the detection were per-call; the
 * `noNodeModulesEmitted` boolean closes that — first call emits, subsequent
 * calls silently return `package_not_installed`. Mirrors M9's "loud about
 * subtrees, quiet about individual files" pattern.
 *
 * Exposed to the formatter only per ADR-0026 §13. Committability + future
 * sub-agents stay tool-less until their own ADR.
 */

const InputSchema = z.object({
  package: z
    .string()
    .describe(
      "The literal import path as it appears in source code. Supports subpaths: " +
        '"drizzle-orm", "drizzle-orm/sqlite-core", "@radix-ui/react-dialog", ' +
        '"next/server". Do not strip the subpath — `drizzle-orm/sqlite-core` ' +
        "and `drizzle-orm` resolve to different .d.ts files.",
    ),
  symbol: z
    .string()
    .describe(
      'The symbol path: a top-level name ("with"), a dotted namespace member ' +
        '("Drizzle.with"), or a class/interface member ("User.method").',
    ),
});

export interface MakeLookupTypeDefToolOptions {
  repoRoot: string;
  /** Mutable collector — the tool pushes one entry the first time
   * `node_modules/` is found missing within a single review. */
  degraded: DegradedEntry[];
  /**
   * M12 (ADR-0027): additional roots whose `node_modules/` directories should
   * be probed before falling back to `repoRoot`. In a pnpm workspace, an
   * installed package may live only in `packages/<name>/node_modules`. The
   * resolver tries each root in array order. The "no `node_modules/`"
   * degraded entry only fires when NONE of the roots (including `repoRoot`)
   * has a `node_modules/` directory at all.
   */
  packageSearchRoots?: string[];
}

export function makeLookupTypeDefTool(opts: MakeLookupTypeDefToolOptions) {
  let noNodeModulesEmitted = false;

  return tool({
    description: [
      "Look up a type definition from an installed npm package. Use this",
      "BEFORE asserting facts about a library API — see the 'Verifying",
      "library API claims' section in the system prompt for triggers.",
      "Returns a discriminated union; on found:false, do not assert about",
      "the symbol. Copy the returned `suggestedSource` verbatim into",
      "`Comment.sources[]` — do not reconstruct it.",
    ].join(" "),
    inputSchema: InputSchema,
    execute: async (args: z.infer<typeof InputSchema>): Promise<LookupTypeDefResult> => {
      const probeRoots = [...(opts.packageSearchRoots ?? []), opts.repoRoot];
      const anyHasNodeModules = probeRoots.some((root) =>
        fs.existsSync(path.join(root, "node_modules")),
      );
      if (!anyHasNodeModules) {
        if (!noNodeModulesEmitted) {
          opts.degraded.push({
            kind: "actionable",
            topic: "api-claim-verifier",
            message:
              "no node_modules/ directory — library API verification unavailable; run `npm install` to enable.",
          });
          noNodeModulesEmitted = true;
        }
        return {
          found: false,
          package: args.package,
          symbol: args.symbol,
          reason: "package_not_installed",
        };
      }
      return lookupTypeDef(opts.repoRoot, args.package, args.symbol, {
        packageSearchRoots: opts.packageSearchRoots,
      });
    },
  });
}
