# S7 temporary-tree probe

Run on 2026-10-14 with the installed OpenCode v2.0.25 on macOS. The production nested-`AGENTS.md` gate remains in place; this is an investigation, not its replacement.

Reproduce with `pnpm --filter @warden/cli probe:instruction-tree`. The script creates a temporary Git repo and detached HEAD worktree, uses a loopback Anthropic model stub to request actual OpenCode `read` calls, and removes the fixture and worktree afterwards. No external model is called. The dependency is a local fixture under `node_modules/vendor`, not a downloaded package.

## Git and citation results

- Restoring a changed nested policy file from the comparison base and removing a PR-only policy file preserves every other tracked file's bytes and relative path.
- `resolveDiff` in review mode returns the same commit diff in both trees. A working-tree diff includes the artificial policy restoration, so it must not replace the driver-owned review diff.
- The post-pass accepts a citation of the changed policy against the original repo root. The same citation fails against the restored tree. Separate execution and verification roots are sufficient for this path.
- A fresh HEAD worktree has no installed dependencies or ignored local files. It also omits a subsequent dirty change in the original checkout.

## Live instruction discovery

The loopback stub requests reads of `src/index.ts`, `added/index.ts`, `local/index.ts`, and `node_modules/vendor/index.d.ts`. It records the subsequent model requests. The policy markers are present only in `AGENTS.md` files; the script never requests those policy files directly.

| Tree | Changed PR policy | PR-only policy | Base policy | Ignored local policy | Dependency policy |
| --- | --- | --- | --- | --- | --- |
| Original HEAD checkout plus local files | loaded | loaded | absent | loaded | loaded |
| HEAD worktree with tracked policies restored/removed | absent | absent | loaded | absent | absent |
| Restored tree with copied local files and linked dependencies | absent | absent | loaded | loaded | loaded |
| Final tree with all nested policies removed and dependency definition copied | absent | absent | absent | absent | absent |

Restoring the tracked policy files blocks the PR versions but retains base instructions. Linking dependencies or copying ignored files reopens instruction discovery. The final prepared tree must therefore be checked after dependency and local-file preparation. Sanitizing only the tracked diff is insufficient.

## Decisions needed before replacing the gate

1. **Base policy authority.** Restore base policies as trusted instructions, or remove all nested policies from the execution tree. Removing all policies is consistent with ADR-0054's rule that repo text is evidence, never instruction. Restoration needs an explicit exception to that rule. The original policy changes remain in the driver-owned diff and can be verified against the original root.
2. **Checkout support.** Start with clean, committed PR checkouts, or also support staged and working changes. A plain HEAD worktree cannot represent dirty changes. Supporting them requires an explicit snapshot and a fixed diff for that snapshot.
3. **Dependencies and local context.** Define which ignored files the lane needs and how to provide dependencies without shared instruction-bearing trees. A `node_modules` symlink is insufficient. A prepared dependency copy must preserve the required resolution behavior while excluding policy files. Do not remove files from the user's installed dependencies.
4. **Root ownership and lifecycle.** Keep the original diff, base, scope, and verification root driver-owned. Route OpenCode reads to the prepared tree. Define which root MCP detectors use, where caches belong, and how policy-file evidence reaches the lane. Verify against the same original snapshot throughout the run, and remove the temporary tree on success and failure.

Recommended first scope: clean PR checkouts, no nested policy authority, and an explicit dependency preparation step. Keep the current gate until that contract and its failure-path tests are implemented. This probe does not test package-manager installs, real monorepo dependency resolution, concurrent checkout changes, or a complete production MCP run inside the temporary tree.
