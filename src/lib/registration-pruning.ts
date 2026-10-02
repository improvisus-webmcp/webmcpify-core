type Node = { type: string; start?: number | null; end?: number | null; [key: string]: unknown };
const node = (value: unknown): value is Node => Boolean(value && typeof value === "object" && "type" in value);

function walk(value: unknown, visit: (entry: Node, parent?: Node) => void, parent?: Node): void {
  if (Array.isArray(value)) { value.forEach(entry => walk(entry, visit, parent)); return; }
  if (!node(value)) return;
  visit(value, parent);
  for (const [key, child] of Object.entries(value)) {
    if (!["loc", "comments", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(key)) walk(child, visit, value);
  }
}

function unwrap(value: unknown): unknown {
  while (node(value) && ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "ParenthesizedExpression"].includes(value.type)) value = value.expression;
  return value;
}

function property(value: unknown): string | undefined {
  if (!node(value) || value.type !== "MemberExpression" || value.computed) return undefined;
  return node(value.property) && value.property.type === "Identifier" ? String(value.property.name) : undefined;
}

/**
 * Only remove discarded, inline registrations on a proven modelContext alias.
 * Never splice arbitrary strings, edit application handlers, or infer dynamic
 * registrations. An ambiguous binding, shared expression, remaining reference,
 * or unsupported syntax delegates the entire revision to the coding provider.
 */
export async function planRegistrationPruning(
  files: Array<{ path: string; source: string }>,
  rejectedNames: string[],
): Promise<Map<string, string> | undefined> {
  const { parse } = await import("@babel/parser");
  const rejected = new Set(rejectedNames);
  const counts = new Map(rejectedNames.map(name => [name, 0]));
  const changes = new Map<string, string>();
  for (const file of files) {
    if (!rejectedNames.some(name => file.source.includes(name))) continue;
    let ast: unknown;
    try {
      ast = parse(file.source, { sourceType: "unambiguous", plugins: [
        ...(/\.[cm]?tsx?$/i.test(file.path) ? ["typescript" as const] : []),
        ...(/\.(?:[cm]?jsx?|tsx)$/i.test(file.path) ? ["jsx" as const] : []),
      ] });
    } catch { return undefined; }
    const bindings = new Map<string, number>();
    const declarations: Node[] = [];
    const parents = new Map<Node, Node>();
    const addBinding = (value: unknown) => walk(value, entry => {
      if (entry.type === "Identifier") {
        const name = String(entry.name);
        bindings.set(name, (bindings.get(name) ?? 0) + 1);
      }
    });
    walk(ast, (entry, parent) => {
      if (parent) parents.set(entry, parent);
      if (entry.type === "VariableDeclarator") {
        if (parent?.type === "VariableDeclaration" && parent.kind === "const") declarations.push(entry);
        addBinding(entry.id);
      }
      if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|CatchClause)$/.test(entry.type)) {
        addBinding(entry.id); addBinding(entry.params); addBinding(entry.param);
      }
      if (/^Import.*Specifier$/.test(entry.type)) addBinding(entry.local);
      if (entry.type === "ClassDeclaration") addBinding(entry.id);
    });
    const aliases = new Map<string, Node>();
    const ancestors = (entry: Node): Node[] => {
      const chain: Node[] = [];
      for (let current: Node | undefined = entry; current; current = parents.get(current)) chain.push(current);
      return chain;
    };
    const isContext = (value: unknown): boolean => {
      const expression = unwrap(value);
      if (!node(expression)) return false;
      if (expression.type === "Identifier") {
        const scope = aliases.get(String(expression.name));
        return Boolean(scope && ancestors(expression).includes(scope));
      }
      const object = unwrap(expression.object);
      return property(expression) === "modelContext" && node(object) && object.type === "Identifier"
        && ["navigator", "document"].includes(String(object.name)) && !bindings.has(String(object.name));
    };
    // Resolve narrowing aliases such as `const modelContext = discoveredContext`.
    for (let pass = 0; pass <= declarations.length; pass++) {
      let added = false;
      for (const declaration of declarations) {
        if (node(declaration.id) && declaration.id.type === "Identifier") {
          const name = String(declaration.id.name);
          const scope = ancestors(declaration).find(entry => ["Program", "BlockStatement", "ForStatement", "ForOfStatement", "ForInStatement", "SwitchStatement"].includes(entry.type));
          if (scope && bindings.get(name) === 1 && !aliases.has(name) && isContext(declaration.init)) { aliases.set(name, scope); added = true; }
        }
      }
      if (!added) break;
    }
    let modifiedContext = false;
    const changesRegisterMethod = (value: unknown): boolean => {
      const member = unwrap(value);
      if (!node(member) || member.type !== "MemberExpression" || !isContext(member.object)) return false;
      return property(member) === "registerTool"
        || (member.computed === true && node(member.property) && member.property.type === "StringLiteral" && member.property.value === "registerTool");
    };
    walk(ast, entry => {
      if ((entry.type === "AssignmentExpression" && changesRegisterMethod(entry.left))
        || ((entry.type === "UpdateExpression" || (entry.type === "UnaryExpression" && entry.operator === "delete")) && changesRegisterMethod(entry.argument))) modifiedContext = true;
    });
    if (modifiedContext) return undefined;
    const ranges: Array<{ start: number; end: number }> = [];
    let ambiguous = false;
    walk(ast, (entry, parent) => {
      if (entry.type !== "ExpressionStatement" || !node(entry.expression) || entry.expression.type !== "CallExpression") return;
      const call = entry.expression;
      if (property(call.callee) !== "registerTool" || !node(call.callee) || !isContext(call.callee.object)) return;
      const args = call.arguments;
      if (!Array.isArray(args) || args.length !== 1 || !node(args[0]) || args[0].type !== "ObjectExpression") return;
      const properties = args[0].properties;
      if (!Array.isArray(properties)) return;
      const names = properties.filter(prop => node(prop) && prop.type === "ObjectProperty" && !prop.computed
        && node(prop.key) && ["Identifier", "StringLiteral"].includes(prop.key.type)
        && (prop.key.name ?? prop.key.value) === "name");
      if (names.length !== 1 || !node(names[0]) || !node(names[0].value) || names[0].value.type !== "StringLiteral") return;
      const name = String(names[0].value.value);
      if (!rejected.has(name)) return;
      if (!parent || !["BlockStatement", "Program"].includes(parent.type)
        || properties.some(prop => node(prop) && (prop.type === "SpreadElement" || prop.computed))
        || typeof entry.start !== "number" || typeof entry.end !== "number") { ambiguous = true; return; }
      counts.set(name, (counts.get(name) ?? 0) + 1);
      ranges.push({ start: entry.start, end: entry.end });
    });
    // A cleanup, registry array, hook, or other shared use of a rejected name
    // outside the removable statement makes this a provider-assisted revision.
    walk(ast, entry => {
      if (entry.type === "StringLiteral" && rejected.has(String(entry.value))
        && !ranges.some(range => typeof entry.start === "number" && entry.start >= range.start && entry.start < range.end)) ambiguous = true;
    });
    if (ambiguous) return undefined;
    let source = file.source;
    for (const range of ranges.sort((left, right) => right.start - left.start)) source = source.slice(0, range.start) + source.slice(range.end);
    if (source !== file.source) changes.set(file.path, source);
  }
  return [...counts.values()].every(count => count === 1) ? changes : undefined;
}
