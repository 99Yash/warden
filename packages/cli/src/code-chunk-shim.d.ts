// Mirror of `@warden/core/src/code-chunk-shim.d.ts`. The CLI transitively
// type-checks code-chunk's `src/types.ts` (its `exports.types` resolves to
// raw source, and `skipLibCheck` doesn't apply to `.ts` files). Keeping
// the shim duplicated rather than shared in a workspace types package —
// 10 lines isn't worth the workspace dance.
declare namespace WebAssembly {
  interface Module {}
  interface Memory {}
  interface Instance {}
  interface Global {}
  interface Table {}
  interface CompileError {}
  interface RuntimeError {}
  interface LinkError {}
}
