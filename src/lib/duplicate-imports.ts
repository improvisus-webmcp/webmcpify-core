import { createRequire } from "node:module";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** Remove identical repeated named imports, never conflicting bindings.
 * Only changed source in the disposable workspace is eligible. */
export async function removeDuplicateImports(workspace: string, changedFiles: string[]): Promise<number> {
  const root = await realpath(workspace);
  let changed = 0;
  for (const file of new Set(changedFiles)) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const candidate = path.resolve(root, file);
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    let filename: string;
    try { filename = await realpath(candidate); } catch { continue; }
    const resolved = path.relative(root, filename);
    if (resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) continue;
    const source = await readFile(filename, "utf8");
    const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");
    let ast: ReturnType<typeof parse>;
    try { ast = parse(source, { sourceType: "unambiguous", errorRecovery: true, plugins: [
      ...(/\.[cm]?tsx?$/.test(file) ? ["typescript" as const] : []),
      ...(/\.(?:[cm]?jsx?|tsx)$/.test(file) ? ["jsx" as const] : []),
    ] }); } catch { continue; }
    const seen = new Map<string, string>();
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const declaration of ast.program.body) {
      if (declaration.type !== "ImportDeclaration" || !declaration.specifiers.length
        || declaration.attributes?.length || declaration.assertions?.length || declaration.phase
        || !declaration.specifiers.every(specifier => specifier.type === "ImportSpecifier")) continue;
      const start = declaration.start!, end = declaration.end!;
      // Preserve comments and unusual import syntax rather than rewriting it.
      if (ast.comments?.some(comment => comment.start! >= start && comment.end! <= end)) continue;
      const kept = declaration.specifiers.filter(specifier => {
        if (specifier.type !== "ImportSpecifier") return true;
        const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
        const signature = JSON.stringify([declaration.source.value, declaration.importKind ?? "value", specifier.importKind ?? "value", imported]);
        const previous = seen.get(specifier.local.name);
        if (previous === signature) return false;
        // Conflicts stay conflicts; never silently choose another module/type.
        if (!previous) seen.set(specifier.local.name, signature);
        return true;
      });
      if (kept.length === declaration.specifiers.length) continue;
      edits.push({ start, end, text: kept.length
        ? source.slice(start, declaration.specifiers[0].start!) + kept.map(specifier => source.slice(specifier.start!, specifier.end!)).join(", ") + source.slice(declaration.specifiers.at(-1)!.end!, end)
        : "" });
    }
    if (!edits.length) continue;
    let revised = source;
    for (const edit of edits.reverse()) revised = revised.slice(0, edit.start) + edit.text + revised.slice(edit.end);
    await writeFile(filename, revised, "utf8");
    changed++;
  }
  return changed;
}
