type Node = { type: string; [key: string]: unknown };
const node = (value: unknown): value is Node => Boolean(value && typeof value === "object" && "type" in value);

/** Prove attribute presence on this form, not in a comment, type or another form. */
export async function hasAutomaticFormSubmission(source: string, file: string, toolName: string): Promise<boolean> {
  const forms: Array<Map<string, unknown>> = [];
  if (/\.[cm]?[jt]sx?$/i.test(file)) {
    const { parse } = await import("@babel/parser");
    let ast: unknown;
    try { ast = parse(source, { sourceType: "unambiguous", plugins: ["jsx", "typescript", "decorators-legacy"] }); }
    catch { return false; }
    const bindings = new Map<string, unknown>();
    function walk(value: unknown, visit: (entry: Node) => void): void {
      if (Array.isArray(value)) { value.forEach(entry => walk(entry, visit)); return; }
      if (!node(value)) return;
      visit(value);
      for (const [key, child] of Object.entries(value)) {
        if (!["loc", "comments", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(key)) walk(child, visit);
      }
    }
    walk(ast, entry => {
      if (entry.type === "VariableDeclarator" && node(entry.id) && entry.id.type === "Identifier") {
        const key = String(entry.id.name);
        bindings.set(key, bindings.has(key) ? undefined : entry.init);
      }
    });
    function resolve(value: unknown, seen = new Set<string>()): unknown {
      if (!node(value)) return undefined;
      if (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression", "JSXExpressionContainer"].includes(value.type)) return resolve(value.expression, seen);
      if (value.type === "StringLiteral") return value.value;
      if (value.type === "Identifier") {
        const key = String(value.name);
        if (seen.has(key)) return undefined;
        return resolve(bindings.get(key), new Set([...seen, key]));
      }
      if (value.type !== "ObjectExpression" || !Array.isArray(value.properties)) return undefined;
      const attributes = new Map<string, unknown>();
      for (const property of value.properties) {
        if (!node(property)) continue;
        if (property.type === "SpreadElement") {
          const spread = resolve(property.argument, seen);
          if (!(spread instanceof Map)) return undefined;
          for (const [key, entry] of spread) attributes.set(key, entry);
        } else if (property.type === "ObjectProperty" && node(property.key)) {
          const key = property.computed ? resolve(property.key, seen) : property.key.name ?? property.key.value;
          if (typeof key === "string") attributes.set(key, resolve(property.value, seen));
        }
      }
      return attributes;
    }
    walk(ast, entry => {
      if (entry.type !== "JSXOpeningElement" || !node(entry.name) || entry.name.name !== "form" || !Array.isArray(entry.attributes)) return;
      const attributes = new Map<string, unknown>();
      for (const attribute of entry.attributes) {
        if (!node(attribute)) continue;
        if (attribute.type === "JSXSpreadAttribute") {
          const spread = resolve(attribute.argument);
          if (!(spread instanceof Map)) { attributes.clear(); continue; }
          for (const [key, value] of spread) attributes.set(key, value);
        } else if (attribute.type === "JSXAttribute" && node(attribute.name)) {
          // Unknown lowercase React attributes must be strings, not boolean props.
          attributes.set(String(attribute.name.name), resolve(attribute.value));
        }
      }
      forms.push(attributes);
    });
  } else {
    const markup = source.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    for (const match of markup.matchAll(/<form\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
      const attributes = new Map<string, unknown>();
      for (const attribute of match[0].slice(5, -1).matchAll(/([^\s=<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        const key = attribute[1];
        const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
        if (key === "toolname" || key === "toolautosubmit") attributes.set(key, value);
        if (["[attr.toolautosubmit]", ":toolautosubmit", "v-bind:toolautosubmit"].includes(key)) {
          attributes.set("toolautosubmit", /^(?:''|"")$/.test(value.trim()) ? "" : undefined);
        }
      }
      forms.push(attributes);
    }
  }
  const matching = forms.filter(form => form.get("toolname") === toolName);
  const candidates = matching.length ? matching : forms.length === 1 && !forms[0].get("toolname") ? forms : [];
  return candidates.length === 1 && typeof candidates[0].get("toolautosubmit") === "string";
}
