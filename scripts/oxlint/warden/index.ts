import { eslintCompatPlugin } from "@oxlint/plugins";

import { noExportedHasherRule } from "./rules/no-exported-hasher.ts";
import { sha256OverJsonStringifyRule } from "./rules/sha256-over-json-stringify.ts";

/**
 * Warden's own lint rules: first-party source, unlike the vendored anti-slop
 * set beside it. ./README.md says what belongs here and how a rule is proven.
 */
const wardenPlugin = eslintCompatPlugin({
  meta: { name: "warden" },
  rules: {
    "no-exported-hasher": noExportedHasherRule,
    "sha256-over-json-stringify": sha256OverJsonStringifyRule,
  },
});

export default wardenPlugin;
