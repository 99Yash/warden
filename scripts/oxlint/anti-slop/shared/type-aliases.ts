import type { ESTree } from "@oxlint/plugins";

export function collectTypeAliasesFromProgram(
  program: ESTree.Program,
): Map<string, ESTree.TSTypeAliasDeclaration> {
  const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "TSTypeAliasDeclaration") {
      aliases.set(declaration.id.name, declaration);
    }
  }
  return aliases;
}
