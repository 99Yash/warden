import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "runtimeTypeof" };
const allowInTypeGuards = [{ allowInTypeGuards: true }];

tester.run("anti-slop/no-runtime-typeof", noRuntimeTypeofRule, {
  valid: [
    "const value = input;",
    // An existence probe asks whether a binding exists, not what representation it has.
    'const isServer = typeof document === "undefined";',
    'const hasStorage = typeof localStorage !== "undefined";',
    'if (typeof globalThis.crypto === "undefined") throw new Error("no crypto");',
    'const missing = "undefined" === typeof process;',
    {
      code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
      options: allowInTypeGuards,
    },
    {
      code: 'const isString = (value: unknown): value is string => typeof value === "string";',
      options: allowInTypeGuards,
    },
    {
      code: 'function assertString(value: unknown): asserts value is string { if (typeof value !== "string") throw new Error(); }',
      options: allowInTypeGuards,
    },
  ],
  invalid: [
    { code: 'if (typeof input === "string") use(input);', errors: [error] },
    // The bare `undefined` identifier is a representation comparison, not an existence probe.
    { code: "if (typeof input === undefined) use(input);", errors: [error] },
    {
      code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
      errors: [error],
    },
    {
      code: 'function parse(value: unknown): string { if (typeof value !== "string") throw new Error(); return value; }',
      options: allowInTypeGuards,
      errors: [error],
    },
    {
      code: 'function isString(value: unknown): value is string { const check = () => typeof value === "string"; return check(); }',
      options: allowInTypeGuards,
      errors: [error],
    },
  ],
});
