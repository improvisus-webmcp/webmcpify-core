import { createHash } from "node:crypto";

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node => Boolean(value && typeof value === "object" && "type" in value);
function walk(value: unknown, visit: (node: Node) => void | false): void {
  if (Array.isArray(value)) { value.forEach(entry => walk(entry, visit)); return; }
  if (!isNode(value)) return;
  if (visit(value) === false) return;
  for (const [key, child] of Object.entries(value)) {
    if (!["loc", "comments", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(key)) walk(child, visit);
  }
}
function name(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (["Identifier", "JSXIdentifier"].includes(value.type)) return String(value.name);
  if (["StringLiteral", "Literal"].includes(value.type) && typeof value.value === "string") return value.value;
  if (["MemberExpression", "OptionalMemberExpression"].includes(value.type)) {
    if (value.computed && (!isNode(value.property) || !["StringLiteral", "Literal"].includes(value.property.type))) return undefined;
    return name(value.property);
  }
  return undefined;
}
function line(value: Node): number {
  const loc = value.loc as { start?: { line?: number } } | undefined;
  return loc?.start?.line ?? 1;
}

export interface ActionCandidate {
  id: string;
  file: string;
  line: number;
  handler: string;
  kind: "handler" | "state-action" | "event-reference";
  /** Resolved definitions require explicit coverage; references remain inspection hints. */
  resolved: boolean;
}

/** Expand conditional/multiline event bindings; never treat generated registrations as actions. */
export async function inventoryActions(file: string, source: string): Promise<{ candidates: ActionCandidate[]; warning?: string }> {
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return { candidates: [] };
  const { parse } = await import("@babel/parser");
  let ast: unknown;
  try {
    ast = parse(source, { sourceType: "unambiguous", plugins: [
      ...(/\.[cm]?tsx?$/i.test(file) ? ["typescript" as const] : []),
      ...(/\.(?:[cm]?jsx?|tsx)$/i.test(file) ? ["jsx" as const] : []),
      "decorators-legacy",
    ] });
  } catch {
    // Keep regex signals, and disclose incomplete parsing rather than guessing.
    return { candidates: [], warning: `Structured action parsing unavailable for ${file}; inspect its discovery signals and source manually.` };
  }
  const references = new Map<string, Node>();
  const definitions: Array<{ handler: string; node: Node; mutation: boolean }> = [];
  const recordReferences = (value: unknown): void => {
    if (!isNode(value)) return;
    if (["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "ParenthesizedExpression"].includes(value.type)) { recordReferences(value.expression); return; }
    if (value.type === "Identifier" || /MemberExpression$/.test(value.type)) {
      const handler = name(value);
      if (handler) references.set(handler, value);
    } else if (value.type === "ConditionalExpression") {
      recordReferences(value.consequent); recordReferences(value.alternate);
    } else if (["LogicalExpression", "SequenceExpression"].includes(value.type)) {
      recordReferences(value.left); recordReferences(value.right);
      if (Array.isArray(value.expressions)) value.expressions.forEach(recordReferences);
    } else {
      walk(value, entry => {
        if (["CallExpression", "OptionalCallExpression"].includes(entry.type)) recordReferences(entry.callee);
      });
    }
  };
  walk(ast, entry => {
    if (["CallExpression", "OptionalCallExpression"].includes(entry.type) && ["registerTool", "provideContext"].includes(name(entry.callee) ?? "")) return false;
    if (entry.type === "JSXAttribute" && /^on[A-Z]/.test(name(entry.name) ?? "") && isNode(entry.value)) {
      recordReferences(entry.value.expression);
    }
    if (["CallExpression", "OptionalCallExpression"].includes(entry.type) && name(entry.callee) === "addEventListener" && Array.isArray(entry.arguments)) recordReferences(entry.arguments[1]);
    let handler: string | undefined;
    let body: unknown;
    if (["FunctionDeclaration", "ClassMethod", "ObjectMethod"].includes(entry.type)) {
      handler = name(entry.id ?? entry.key); body = entry.body;
    } else if (["VariableDeclarator", "ObjectProperty"].includes(entry.type)) {
      const fn = entry.init ?? entry.value;
      if (isNode(fn) && ["ArrowFunctionExpression", "FunctionExpression"].includes(fn.type)) {
        handler = name(entry.id ?? entry.key); body = fn.body;
      }
    }
    if (!handler || !body) return;
    let mutation = false;
    // Named store actions using the store setter are candidates even when a
    // conditional UI exposes only one branch at a time (e.g. login/logout).
    if (["ObjectProperty", "ObjectMethod"].includes(entry.type)) walk(body, child => {
      if (["CallExpression", "OptionalCallExpression"].includes(child.type)
        && ["set", "setState", "dispatch", "update"].includes(name(child.callee) ?? "")) mutation = true;
    });
    // Do not classify entire components or arbitrary helper functions as store actions.
    definitions.push({ handler, node: entry, mutation });
  });
  const candidates: ActionCandidate[] = [];
  const defined = new Set<string>();
  const add = (handler: string, node: Node, kind: ActionCandidate["kind"], resolved: boolean): void => {
    const at = line(node);
    candidates.push({ id: createHash("sha256").update(`${file}:${at}:${node.start}:${handler}:${kind}`).digest("hex").slice(0, 20), file, line: at, handler, kind, resolved });
  };
  for (const definition of definitions) {
    if (!definition.mutation && !references.has(definition.handler)) continue;
    defined.add(definition.handler);
    add(definition.handler, definition.node, definition.mutation ? "state-action" : "handler", true);
  }
  for (const [handler, node] of references) if (!defined.has(handler)) add(handler, node, "event-reference", false);
  return { candidates: candidates.sort((a, b) => a.line - b.line || a.handler.localeCompare(b.handler)) };
}
