// Ambient shim for the `WebAssembly` namespace referenced by code-chunk's
// `src/types.ts` (which is reached through code-chunk's `exports.types`
// pointing at raw source rather than the compiled .d.ts). `skipLibCheck`
// only skips `.d.ts` files; the .ts source is type-checked as a project
// file and needs the global resolved. Loading the full DOM lib pulls in
// too much; declaring the minimal namespace surface keeps the blast
// radius small.
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
