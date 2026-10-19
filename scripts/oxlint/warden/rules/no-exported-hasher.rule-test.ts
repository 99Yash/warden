import { RuleTester } from "oxlint/plugins-dev";

import { noExportedHasherRule } from "./no-exported-hasher.ts";

// The spec of `no-exported-hasher`. Each export form of a function whose parameter
// flows into a raw digest is a must-catch case, and so is each re-export of an owner
// hasher. The owner module, a private helper, and a function that hashes through the
// owner hasher are must-ignore cases.
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const exported = (name: string) => ({ messageId: "exportedHasher", data: { name } });

const reexported = (name: string) => ({ messageId: "reexportedHasher", data: { name } });

// Ported from alfred's `scripts/oxlint/alfred/rules/no-exported-hasher.rule-test.ts`.
// The cases are alfred's, with the owner module, its specifier and its hasher names
// rewritten to warden's (`packages/core/src/hash.ts`, `@warden/core/hash`, `sha256Hex`).
// The cases marked "warden:" are this tree's own hashers before the owner existed.

tester.run("warden/no-exported-hasher", noExportedHasherRule, {
  valid: [
    {
      // The owner module defines and exports the hasher.
      name: "the owner module exports its hasher",
      filename: "packages/core/src/hash.ts",
      code: `import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}`,
    },
    {
      // A private helper is in reach of warden/sha256-over-json-stringify, which reads
      // each call of it in this file.
      name: "a private helper whose parameter flows into a digest",
      code: `import { createHash } from "node:crypto";

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const VERSION_HASH = hashOf("v1");`,
    },
    {
      name: "an exported function that hashes a value it makes, not a parameter",
      code: `import { createHash, randomUUID } from "node:crypto";

export function freshToken(prefix: string): string {
  return \`\${prefix}:\${createHash("sha256").update(randomUUID()).digest("hex")}\`;
}`,
    },
    {
      // A function that hashes its input through the owner hasher is a normal domain
      // function. The rule cannot tell it from a wrapper, so it is out of reach (see
      // "Out of reach" in the rule comment).
      name: "an exported function that hashes its parameter through the owner hasher",
      code: `import { sha256Hex } from "@warden/core/hash";

export function traceId(runId: string): string {
  return sha256Hex(runId).slice(0, 32);
}`,
    },
    {
      // warden: \`comment-id.ts\` and \`indexing/job-runner.ts\` after the owner.
      name: "warden: domain functions that hash through the owner over a relative import",
      filename: "packages/core/src/indexing/job-runner.ts",
      code: `import { canonicalJson, sha256Hex } from "../hash.js";

export function taskIdFor(kind: string, input: unknown): string {
  return sha256Hex(\`\${kind}:\${canonicalJson(input)}\`);
}

export function stableCommentId(key: string): string {
  return \`W-\${sha256Hex(key).slice(0, 10)}\`;
}`,
    },
    {
      // A MAC is not a content hash, and a Drizzle update is not a hasher.
      name: "an exported HMAC and an exported database update",
      code: `import { createHmac } from "node:crypto";

export function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function rename(id: string, title: string): Promise<void> {
  await db.update(threads).set({ title }).where(eq(threads.id, id));
}`,
    },
    {
      // A #private method is not reachable from another file.
      name: "a private method of an exported class",
      code: `import { createHash } from "node:crypto";

export class Vault {
  #keyId(key: Uint8Array): string {
    return createHash("sha256").update(key).digest("hex");
  }

  open(): string {
    return this.#keyId(new Uint8Array(32));
  }
}`,
    },
    {
      // Importing an owner hasher to call it is the intended form.
      name: "an import of an owner hasher that the module only calls",
      code: `import { canonicalJson, sha256Hex } from "@warden/core/hash";

const key = sha256Hex(rawBody);
const evidence = sha256Hex(canonicalJson(payload));`,
    },
    {
      name: "a hasher in a test tree is out of scope",
      filename: "packages/core/test/support/hash.ts",
      code: `import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}`,
    },
    {
      // Smoke scripts and probes are out of scope, as in alfred.
      name: "a hasher under a scripts directory is out of scope",
      filename: "packages/cli/scripts/smoke-hash.ts",
      code: `import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}`,
    },
  ],
  invalid: [
    {
      // warden: \`packages/core/src/context/chunker.ts\` before the owner.
      name: "an exported function declaration",
      code: `import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}`,
      errors: [exported("sha256")],
    },
    {
      name: "an exported const arrow and an exported function expression",
      code: `import { createHash } from "node:crypto";

export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export const digestOf = function (bytes: Uint8Array) {
  return crypto.subtle.digest("SHA-256", bytes);
};`,
      errors: [exported("hashOf"), exported("digestOf")],
    },
    {
      name: "a local function exposed by an export specifier, plain and renamed",
      code: `import { createHash } from "node:crypto";

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const keyOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export { hashOf, keyOf as contentKey };`,
      errors: [exported("hashOf"), exported("keyOf")],
    },
    {
      name: "an anonymous default export",
      code: `import { createHash } from "node:crypto";

export default function (text: string): string {
  return createHash("sha256").update(text).digest("hex");
}`,
      errors: [exported("default")],
    },
    {
      name: "a local const exposed by a default export",
      code: `import { createHash } from "node:crypto";

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export default hashOf;`,
      errors: [exported("hashOf")],
    },
    {
      name: "an exported object literal of functions, nested",
      code: `import { createHash } from "node:crypto";

export const hashing = {
  of(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  },
  bytes: {
    digest: (bytes: Uint8Array) => crypto.subtle.digest("SHA-256", bytes),
  },
};`,
      errors: [exported("hashing.of"), exported("hashing.bytes.digest")],
    },
    {
      name: "an object literal exposed by an export specifier",
      code: `import { createHash } from "node:crypto";

const hashing = {
  of: (text: string): string => createHash("sha256").update(text).digest("hex"),
};

export { hashing };`,
      errors: [exported("hashing.of")],
    },
    {
      name: "a method of an exported class",
      code: `import { createHash } from "node:crypto";

export class Hasher {
  of(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }
}`,
      errors: [exported("Hasher.of")],
    },
    {
      // The parameter reaches the digest through a private helper.
      name: "an exported function whose parameter reaches a private helper",
      code: `import { createHash } from "node:crypto";

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function userKey(userId: string): string {
  return hashOf(\`user:\${userId}\`);
}`,
      errors: [exported("userKey")],
    },
    {
      // A destructured parameter, a property read and a bound hasher.
      name: "an exported function that hashes a destructured or nested parameter",
      code: `import { createHash } from "node:crypto";

export function receive({ raw }: { raw: string }): string {
  const hash = createHash("sha256");
  hash.update(raw);
  return hash.digest("hex");
}

export function audit(args: { body: string }): string {
  return createHash("sha256").update(args.body).digest("hex");
}`,
      errors: [exported("receive"), exported("audit")],
    },
    {
      name: "a re-export of an owner hasher from its module",
      code: `export { sha256Hex } from "@warden/core/hash";
export * from "@warden/core/hash";`,
      errors: [reexported("sha256Hex"), reexported("sha256Hex")],
    },
    {
      name: "an export of a local import of an owner hasher, in each form",
      code: `import { sha256Hex } from "@warden/core/hash";

export { sha256Hex };
export const digest = sha256Hex;
export default sha256Hex;`,
      errors: [reexported("sha256Hex"), reexported("sha256Hex"), reexported("sha256Hex")],
    },
    {
      // A relative specifier inside the owner's package resolves to the owner.
      // warden: \`context/index.ts\` re-exported \`sha256Hex\` from the chunker.
      name: "a re-export of an owner hasher through a relative path",
      filename: "packages/core/src/context/index.ts",
      code: `export { sha256Hex } from "../hash.js";`,
      errors: [reexported("sha256Hex")],
    },
    {
      // warden: \`comment-id.ts\` and \`indexing/job-runner.ts\` before the owner.
      name: "warden: domain functions that inline their own digest",
      code: `import { createHash } from "node:crypto";

export function stableCommentId(key: string): string {
  return \`W-\${createHash("sha256").update(key).digest("hex").slice(0, 10)}\`;
}

export function taskIdFor(kind: string, input: unknown): string {
  const json = canonicalJson(input);
  return createHash("sha256").update(\`\${kind}:\${json}\`, "utf8").digest("hex");
}`,
      errors: [exported("stableCommentId"), exported("taskIdFor")],
    },
  ],
});
