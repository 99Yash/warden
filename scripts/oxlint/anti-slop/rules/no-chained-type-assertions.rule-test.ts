import { RuleTester } from "oxlint/plugins-dev";

import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "chained" };

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: [
    "const user = input as User;",
    "const value = <const>input;",
    "const value = <const>(input as const);",
  ],
  invalid: [
    { code: "const user = input as object as User;", errors: [error] },
    { code: "const user = <User>(input as object);", errors: [error] },
    { code: "const user = (input as unknown) as User;", errors: [error] },
  ],
});
