import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { extractUnifiedDiff } from "./patches.js";
import type { ProposedTool } from "./tool-proposals.js";

type Node = { type: string; [key: string]: unknown };
const node = (value: unknown): value is Node => Boolean(value && typeof value === "object" && "type" in value);
function walk(value: unknown, visit: (entry: Node) => void): void {
  if (Array.isArray(value)) { value.forEach(child => walk(child, visit)); return; }
  if (!node(value)) return;
  visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (!["loc", "comments", "tokens"].includes(key)) walk(child, visit);
  }
}
const identifier = (value: unknown): string | undefined => node(value) && value.type === "Identifier" ? String(value.name) : undefined;
const keyName = (value: unknown): string | undefined => identifier(value) ?? (node(value) && value.type === "StringLiteral" ? String(value.value) : undefined);
const literal = (value: unknown): boolean => node(value) && ["StringLiteral", "BooleanLiteral", "NumericLiteral", "NullLiteral"].includes(value.type);
function data(value: unknown): boolean {
  if (literal(value)) return true;
  return node(value) && value.type === "ObjectExpression" && Array.isArray(value.properties)
    && value.properties.every(property => node(property) && property.type === "ObjectProperty" && !property.computed && data(property.value));
}

/** Apply only exact, ordinary text hunks in memory. Never write/apply a draft
 * during security review; unsupported binary/rename syntax stays conservative. */
function reviewedSource(original: string, patch: string, file: string): string | undefined {
  const section = patch.split(/(?=^diff --git )/m).find(value => value.split(/\r?\n/).includes(`+++ b/${file}`));
  if (!section || !section.split(/\r?\n/).includes(`--- a/${file}`)) return undefined;
  const lines = original.split(/\r?\n/), result: string[] = [];
  const changes = section.split(/\r?\n/);
  let cursor = 0, hunks = 0;
  for (let at = 0; at < changes.length; at++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(changes[at]);
    if (!header) continue;
    const start = Math.max(0, Number(header[1]) - 1), removed = Number(header[2] ?? 1), added = Number(header[4] ?? 1);
    if (start < cursor || start > lines.length) return undefined;
    result.push(...lines.slice(cursor, start)); cursor = start;
    let oldCount = 0, newCount = 0;
    for (at++; at < changes.length && !changes[at].startsWith('@@ '); at++) {
      const change = changes[at];
      if (change.startsWith('\\ No newline')) continue;
      if (!change && at === changes.length - 1) break;
      if (![" ", "+", "-"].includes(change[0])) return undefined;
      if (change[0] !== '+') {
        if (lines[cursor++] !== change.slice(1)) return undefined;
        oldCount++;
      }
      if (change[0] !== '-') { result.push(change.slice(1)); newCount++; }
    }
    if (oldCount !== removed || newCount !== added) return undefined;
    hunks++; at--;
  }
  return hunks ? [...result, ...lines.slice(cursor)].join('\n') : undefined;
}

/** Narrow source evidence, never a general effect/sandbox proof. Unknown syntax,
 * helpers, custom persistence, setters, getters, network calls and shadowed
 * factories retain the ordinary consequential-action checks. */
export function hasLocalStoreEffect(tool: ProposedTool, sourceRoot: string, inspectPendingPatch: boolean): boolean {
  const match = /^(.+\.[cm]?[jt]sx?)#([A-Za-z_$][\w$]*)$/.exec(tool.implementation.handler);
  if (!match || !tool.sourceFiles.includes(match[1])) return false;
  try {
    const root = realpathSync(sourceRoot);
    const filename = realpathSync(path.resolve(root, match[1]));
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return false;
    let source = readFileSync(filename, "utf8");
    // Inspect changed pending handlers through exact in-memory hunks, not the
    // old owner source. Generation instead inspects its actual workspace.
    const metadataPath = path.join(root, ".webmcpify", "pending-diff.meta.json");
    if (inspectPendingPatch && existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (metadata.patchStatus !== "applied") {
        const patch = readFileSync(path.join(root, ".webmcpify", "pending-diff.patch"), "utf8");
        if (createHash("sha256").update(patch).digest("hex") !== metadata.patchHash) return false;
        if (extractUnifiedDiff(patch).changedFiles.includes(match[1])) {
          const revised = reviewedSource(source, patch, match[1]);
          if (revised === undefined) return false;
          source = revised;
        }
      }
    }
    const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");
    const ast = parse(source, { sourceType: "unambiguous", plugins: [
      ...(/\.[cm]?tsx?$/i.test(filename) ? ["typescript" as const] : []),
      ...(/\.(?:[cm]?jsx?|tsx)$/i.test(filename) ? ["jsx" as const] : []),
    ] });
    let create: string | undefined, persist: string | undefined;
    walk(ast, entry => {
      if (entry.type !== "ImportDeclaration" || !node(entry.source) || !Array.isArray(entry.specifiers)) return;
      for (const specifier of entry.specifiers) {
        if (!node(specifier) || specifier.type !== "ImportSpecifier") continue;
        if (entry.source.value === "zustand" && identifier(specifier.imported) === "create") create = identifier(specifier.local);
        if (entry.source.value === "zustand/middleware" && identifier(specifier.imported) === "persist") persist = identifier(specifier.local);
      }
    });
    if (!create) return false;
    let shadowed = false;
    walk(ast, entry => {
      const bindings = entry.type === "VariableDeclarator" ? [entry.id]
        : /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|CatchClause)$/.test(entry.type) ? [entry.id, entry.param, ...(Array.isArray(entry.params) ? entry.params : [])]
          : /^(?:ImportSpecifier|ImportDefaultSpecifier|ImportNamespaceSpecifier)$/.test(entry.type) && identifier(entry.local) === "Error" ? [entry.local]
          : ["AssignmentExpression", "UpdateExpression"].includes(entry.type) ? [entry.left ?? entry.argument] : [];
      for (const binding of bindings) walk(binding, value => {
        if (identifier(value) === create || identifier(value) === "Error" || (persist && identifier(value) === persist)) shadowed = true;
      });
    });
    if (shadowed) return false;
    const matches: boolean[] = [];
    walk(ast, entry => {
      if (entry.type !== "CallExpression" || !Array.isArray(entry.arguments)) return;
      let callee = entry.callee;
      if (node(callee) && callee.type === "CallExpression" && Array.isArray(callee.arguments) && !callee.arguments.length) callee = callee.callee;
      if (identifier(callee) !== create) return;
      let factory = entry.arguments[0];
      if (node(factory) && factory.type === "CallExpression" && persist && identifier(factory.callee) === persist && Array.isArray(factory.arguments)) {
        const options = factory.arguments[1];
        if (options && (!node(options) || options.type !== "ObjectExpression" || !Array.isArray(options.properties)
          || options.properties.some(property => !node(property) || property.type !== "ObjectProperty" || property.computed
            || !["name", "version", "partialize", "merge"].includes(keyName(property.key) ?? "")))) return;
        if (node(options) && Array.isArray(options.properties)) {
          for (const property of options.properties.filter(node)) {
            const key = keyName(property.key);
            if (["name", "version"].includes(key ?? "") && !literal(property.value)) return;
            if (key === "partialize") {
              const fn = property.value;
              if (!node(fn) || fn.type !== "ArrowFunctionExpression" || fn.async || !Array.isArray(fn.params) || fn.params.length !== 1
                || !node(fn.body) || fn.body.type !== "ObjectExpression" || !Array.isArray(fn.body.properties)) return;
              const stateParameter = identifier(fn.params[0]);
              const parameter = fn.params[0];
              const selected = new Set<string>();
              if (!stateParameter) {
                if (!node(parameter) || parameter.type !== "ObjectPattern" || !Array.isArray(parameter.properties)
                  || parameter.properties.some(value => !node(value) || value.type !== "ObjectProperty" || value.computed || !identifier(value.value))) return;
                parameter.properties.forEach(value => { if (node(value)) selected.add(identifier(value.value)!); });
              }
              if (fn.body.properties.some(value => !node(value) || value.type !== "ObjectProperty" || value.computed
                || !(literal(value.value) || selected.has(identifier(value.value) ?? "") || (node(value.value) && value.value.type === "MemberExpression" && !value.value.computed
                  && identifier(value.value.object) === stateParameter && identifier(value.value.property))))) return;
            }
          }
        }
        factory = factory.arguments[0];
      }
      if (!node(factory) || factory.type !== "ArrowFunctionExpression" || !Array.isArray(factory.params)
        || !node(factory.body) || factory.body.type !== "ObjectExpression" || !Array.isArray(factory.body.properties)) return;
      const [set, get] = factory.params.map(identifier);
      if (!set || !get || set === get) return;
      const properties = factory.body.properties.filter(node);
      const action = properties.filter(property => property.type === "ObjectProperty" && !property.computed && keyName(property.key) === match[2]);
      if (action.length !== 1 || !node(action[0].value) || action[0].value.type !== "ArrowFunctionExpression" || action[0].value.async) return;
      const fn = action[0].value;
      if (!Array.isArray(fn.params) || fn.params.length) return;
      let valid = true, wrote = false;
      walk(fn.body, child => {
        if (["CallExpression", "OptionalCallExpression"].includes(child.type)) {
          const called = identifier(child.callee);
          const args = Array.isArray(child.arguments) ? child.arguments : [];
          if (called === set && args.length === 1 && data(args[0])) wrote = true;
          else if (!(called === get && !args.length)) valid = false;
        } else if (child.type === "MemberExpression") {
          const object = child.object;
          const state = properties.find(property => property.type === "ObjectProperty" && !property.computed && keyName(property.key) === keyName(child.property));
          if (child.computed || !node(object) || object.type !== "CallExpression" || identifier(object.callee) !== get || !state || !literal(state.value)) valid = false;
        } else if (child.type === "NewExpression") {
          if (identifier(child.callee) !== "Error" || !Array.isArray(child.arguments) || child.arguments.length !== 1 || !literal(child.arguments[0])) valid = false;
        } else if (!["BlockStatement", "IfStatement", "ThrowStatement", "ExpressionStatement", "ReturnStatement", "UnaryExpression", "LogicalExpression", "BinaryExpression", "Identifier", "ObjectExpression", "ObjectProperty", "StringLiteral", "BooleanLiteral", "NumericLiteral", "NullLiteral"].includes(child.type)) valid = false;
      });
      matches.push(valid && wrote);
    });
    return matches.length === 1 && matches[0];
  } catch { return false; }
}
