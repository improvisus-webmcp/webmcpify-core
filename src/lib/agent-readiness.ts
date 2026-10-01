import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DiscoveryResult } from "./discovery.js";
import type { ProposedTool } from "./tool-proposals.js";

export const AGENT_READINESS_GUIDANCE = `
AGENT-READY INTEGRATION
- Keep the target's language: JavaScript/JSX/mjs/cjs projects get JavaScript,
  never TypeScript syntax, .ts files, or a new tsconfig just for WebMCP. For
  TypeScript projects, use local interfaces only where necessary. Match ESM
  versus CommonJS and the installed framework version. Use existing build checks.
- Register a small, useful capability set with clear schemas and structured
  results. Preserve real handlers, business guards, authentication, consent,
  keyboard operation, and normal human interactions. Label controls, retain
  stable layout, and expose pending/success/error outcomes accessibly.
- Add or reuse a loaded stylesheet for every WebMCP form. Use separately guarded
  @supports selector(form:tool-form-active) and @supports selector(:tool-submit-active)
  rules, with a visible outline rather than layout-changing borders. Include a
  readable 'Agent is filling this form' status, not color alone. Use an existing
  live region or role="status" aria-live="polite"; never CSS-generated text as
  the only notification. Never announce success until the real handler resolves.
- Match toolactivated/toolcancel events by toolName on the supported ModelContext
  event target, feature-detect document.modelContext, and clean up listeners on
  unmount/navigation. Reset status on submit completion, error, cancellation, or
  form reset. Imperative execute callbacks must publish pending/results/errors
  through the site's existing state/status UI and clear pending state in finally.
- React/Next: browser integration belongs in an Effect/client component, with
  cleanup safe under Strict Mode and fresh state via the existing store/refs.
  Reuse the site's CSS modules/global stylesheet and render status in JSX.
  Use nativeEvent for SubmitEvent.agentInvoked/respondWith. Set actual lowercase
  DOM toolname/tooldescription attributes; add local typing only in TS if needed.
- Angular: inspect the installed version; use supported browser lifecycle/SSR
  guards, DestroyRef/ngOnDestroy cleanup, the real reactive form/state, and the
  component stylesheet. Bind custom attributes with [attr.toolname] and
  [attr.tooldescription], not unknown DOM properties. Render status in the template.
- Vanilla JS, Vue, Svelte, and other stacks: use their existing DOM/mount/unmount
  conventions and styles. Import or link all generated CSS and integration files.
- Use toolname/tooldescription on real forms for the current Chrome declarative
  API, preserve validation, and add toolautosubmit only when existing consent and
  confirmation behavior allows it. Prefer the detected runtime, not guessed APIs.
- Core adds llms.txt, webmcp.md, and one combined root AGENTS.md guide inside this disposable
  workspace after validating the proposal. Ensure the site's real static serving
  directory is configured (public/ for most JS frameworks, static/ for SvelteKit,
  angular.json root-output assets for Angular). Do not create duplicate llm.txt,
  robot.txt, .agent.md, fake MCP endpoints, unsupported manifests, or invented sitemap URLs.
- Preserve existing robots.txt groups, disallows, and training/search policies.
  Crawl permission never authorizes purchases or authenticated capabilities.
  Do not add a blanket Allow: / or expose API/admin/account pages to satisfy readiness.
- Keep public documentation free of credentials, private source paths, internal
  security notes, and personal data. Reuse existing sitemaps and semantic metadata
  only where source supports them. llms.txt is an optional emerging convention.
`.trim();

async function optionalText(root: string, file: string): Promise<string | undefined> {
  await assertWorkspacePath(root, file);
  try { return await readFile(path.join(root, file), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function safeRelative(value: string): string | undefined {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes("..") || value.includes("\0")) return undefined;
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
}

/** Resolve a real root-served assets directory; don't invent deployment config. */
export async function agentPublicDirectory(root: string, discovery: DiscoveryResult): Promise<string | undefined> {
  const manifest = await optionalText(root, "package.json");
  let dependencies: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(manifest ?? "{}");
    dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch { /* Malformed manifests do not establish asset serving. */ }
  if (discovery.stack.framework === "Angular") {
    const raw = await optionalText(root, "angular.json");
    if (!raw) return undefined;
    let config;
    try { config = JSON.parse(raw); } catch { return undefined; }
    const directories = new Set<string>();
    for (const project of Object.values(config.projects ?? {}) as Array<{ architect?: { build?: { options?: { assets?: unknown[] } } }; targets?: { build?: { options?: { assets?: unknown[] } } } }>) {
      const assets = (project.architect ?? project.targets)?.build?.options?.assets ?? [];
      for (const asset of assets) {
        if (typeof asset === "object" && asset !== null) {
          const record = asset as Record<string, unknown>;
          if (record.glob !== "**/*" || !["", "/"].includes(String(record.output ?? ""))) continue;
          const relative = typeof record.input === "string" ? safeRelative(record.input) : undefined;
          if (relative && relative !== ".") directories.add(relative);
        }
      }
    }
    return directories.size === 1 ? [...directories][0] : undefined;
  }
  if (discovery.stack.framework === "Svelte" && dependencies["@sveltejs/kit"]) {
    for (const file of ["svelte.config.js", "svelte.config.ts"]) {
      const config = await optionalText(root, file);
      const override = config?.match(/\bassets\s*:\s*["']([^"']+)["']/);
      if (override) return safeRelative(override[1]);
    }
    return "static";
  }
  for (const file of ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.mts", "vite.config.cjs", "vite.config.cts"]) {
    const config = await optionalText(root, file);
    if (config) {
      const rootMatch = config.match(/\broot\s*:\s*["']([^"']+)["']/);
      if (/\broot\s*:/.test(config) && !rootMatch) return undefined;
      const viteRoot = rootMatch ? safeRelative(rootMatch[1]) : ".";
      if (!viteRoot) return undefined;
      const match = config.match(/\bpublicDir\s*:\s*["']([^"']+)["']/);
      if (/\bpublicDir\s*:/.test(config) && !match) return undefined;
      const publicDir = match ? safeRelative(match[1]) : "public";
      return publicDir ? safeRelative(path.posix.join(viteRoot, publicDir)) : undefined;
    }
  }
  if (dependencies.vite) return "public";
  // Older SvelteKit targets may omit the package manifest in focused discovery.
  if (discovery.stack.framework === "Svelte") return "static";
  if (["Next.js", "React", "Vue", "Astro", "Remix"].includes(discovery.stack.framework ?? "")) return "public";
  if (await optionalText(root, "index.html") !== undefined) return ".";
  // An arbitrary server project's directory named public is not proof it is served.
  for (const file of new Set(discovery.apis.map((signal) => signal.file))) {
    const source = await optionalText(root, file);
    const staticDir = source?.match(/express\.static\(\s*["']([^"']+)["']\s*\)/);
    if (staticDir && /app\.use\(\s*express\.static/.test(source!)) return safeRelative(staticDir[1]);
  }
  return undefined;
}

const START = "<!-- webmcpify:begin -->";
const END = "<!-- webmcpify:end -->";

function mergeSection(existing: string | undefined, section: string, heading: string): string {
  const block = `${START}\n${section.trim()}\n${END}`;
  if (!existing) return `${heading}\n\n${block}\n`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && (end < start || existing.indexOf(START, start + START.length) >= 0 || existing.indexOf(END, end + END.length) >= 0))) {
    throw new Error("Agent-readiness document has incomplete or duplicate WebMCPify markers; repair the owner document before regeneration.");
  }
  if (start >= 0 && end >= start) return `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/** Add scoped metadata access only to the wildcard group. Other policies survive. */
export function updateAgentRobots(existing = ""): string {
  const lines = existing.split(/\r?\n/);
  const groups: Array<{ agents: string[]; rules: string[]; end: number }> = [];
  let group: (typeof groups)[number] | undefined;
  for (let index = 0; index < lines.length; index++) {
    const agent = lines[index].match(/^\s*User-agent\s*:\s*([^#]+?)(?:\s*#.*)?$/i);
    if (agent) {
      if (!group || group.rules.length) {
        if (group) group.end = index;
        group = { agents: [], rules: [], end: lines.length };
        groups.push(group);
      }
      group.agents.push(agent[1].trim());
    } else if (group && /^\s*(Allow|Disallow)\s*:/i.test(lines[index])) group.rules.push(lines[index]);
  }
  const wildcardGroups = groups.filter((item) => item.agents.includes("*"));
  const rules = wildcardGroups.flatMap((item) => item.rules);
  const additions = ["/llms.txt$", "/webmcp.md$"].filter((url) => {
    // Explicit restrictions on metadata remain an owner's decision.
    const blocked = rules.some((line) => {
      if (!/^\s*Disallow\s*:/i.test(line)) return false;
      const rule = line.split(":").slice(1).join(":").split("#")[0].trim();
      if (!rule || rule === "/") return false;
      const pattern = rule.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${pattern}`).test(url.slice(0, -1));
    });
    return !blocked && !rules.some((line) => line.trim().toLowerCase() === `allow: ${url}`);
  });
  if (!additions.length) return existing;
  const block = ["# WebMCPify: public capability documentation only", ...additions.map((url) => `Allow: ${url}`)];
  // Never modify a shared group: its named crawlers may have deliberately opted out.
  const wildcardOnly = wildcardGroups.find((item) => item.agents.every((agent) => agent === "*"));
  if (!wildcardOnly) return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}User-agent: *\n${block.join("\n")}\n`;
  lines.splice(wildcardOnly.end, 0, ...block);
  return `${lines.join("\n").trimEnd()}\n`;
}

function publicText(value: string): string {
  return value.replace(/[\r\n<>`]/g, " ").trim();
}

function agentCapabilityGuide(tools: ProposedTool[]): string {
  return tools.map((tool) => {
    const inputs = Object.entries(tool.parameters.properties).map(([name, value]) => {
      const schema = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
      const required = tool.parameters.required?.includes(name) ? "required" : "optional";
      const bounds = ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]
        .filter((key) => typeof schema[key] === "number")
        .map((key) => `${key}: ${schema[key]}`);
      const type = typeof schema.type === "string" ? publicText(schema.type) : "consult the live schema";
      return `- ${publicText(name)}: ${type}; ${required}${bounds.length ? `; ${bounds.join(", ")}` : ""}.`;
    }).join("\n") || "No input fields are declared.";
    const preconditions = tool.behavior.preconditions.map((item) => `- ${publicText(item)}`).join("\n") || "Use the current page's normal interaction rules.";
    const failures = (tool.behavior.expectedFailures ?? []).map((item) => `- ${publicText(item.condition)} → ${publicText(item.error)}`).join("\n") || "No specific expected rejections are declared; report real validation and business-rule errors.";
    return `### ${publicText(tool.name)} — ${publicText(tool.title ?? tool.name)}\n\n${publicText(tool.description)}\n\nInteraction: ${tool.placement?.strategy ?? "inspect the live tool"}. Effect: ${tool.security?.executionScope ?? "confirm from the current application"}. Read-only: ${tool.annotations.readOnlyHint === true ? "yes" : "no"}. Consequential: ${tool.annotations.consequentialHint ? "yes; preserve explicit human confirmation" : "not declared consequential"}.\n\nAuthentication: ${tool.security?.userAuthentication ?? "consult the application"}. Agent identity: ${tool.security?.agentIdentity ?? "consult the application"}. Origin scope: ${tool.security?.originScope ?? "consult the application"}. These declarations do not grant access.\n\n#### Inputs\n\n${inputs}\n\n#### Preconditions and setup\n\n${preconditions}\n\n#### Successful outcome\n\n${publicText(tool.behavior.success ?? "Check the structured result and observable application state.")}\n\n#### Expected rejections\n\n${failures}`;
  }).join("\n\n");
}

async function assertWorkspacePath(root: string, relative: string): Promise<void> {
  if (!safeRelative(relative)) throw new Error(`Invalid agent-readiness path: ${relative}`);
  // Never follow a target-owned symlink outside the disposable workspace.
  for (let current = root, parts = relative.split("/"); parts.length;) {
    current = path.join(current, parts.shift()!);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Agent-readiness path is a symlink: ${relative}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function workspaceWrite(root: string, relative: string, value: string): Promise<void> {
  await assertWorkspacePath(root, relative);
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), value, "utf8");
}

/** These files enter the same exact, reviewed patch as the generated tools. */
export async function writeAgentReadiness(
  workspace: string, discovery: DiscoveryResult, tools: ProposedTool[],
): Promise<{ files: string[]; publicDirectory?: string }> {
  const publicDirectory = await agentPublicDirectory(workspace, discovery);
  const files: string[] = [];
  const repoGuide = `## WebMCP integration\n\nKeep the existing ${discovery.stack.language.join("/") || "source"} conventions. Reuse real UI handlers and state; do not invent backend services for browser-only actions. Guard document.modelContext and clean up registrations/listeners. Preserve authentication and human confirmation for consequential effects.\n\nRead the capability reference in AGENTS.md for the site's proposed capabilities, prerequisites, inputs, outcomes, and rejection handling. Keep this combined guide and public capability documentation synchronized with tool changes. Review generated source, CSS, crawling policy, and documentation together. Run the existing build/typecheck checks and test both human and agent interactions. WebMCP and llms.txt support remain experimental.`;
  const siteGuide = `## Integration provenance\n\nThis site's WebMCP integration is made with WebMCPify Core by Improvisus (improvisus/webmcpify). This credits the integration tooling, not authorship of the experimental WebMCP standard.\n\n## Using the site as an agent\n\nThis guide describes proposed capabilities, not verified deployment or permission to execute them. In a compatible browser, feature-detect document.modelContext and inspect the current page's live tools and schemas before invoking anything. Tool availability can change with route, login, and application state. If WebMCP is unavailable, use the site's accessible human interface; do not invent an HTTP MCP endpoint.\n\nUse the actual form or registered execute handler. Satisfy the listed prerequisites through the existing interface or available tools first. Request user consent where required; never collect passwords, tokens, or payment secrets just to satisfy a tool contract. Respect authentication, origin restrictions, business guards, and crawler policy. Do not bypass a rejection or blindly retry consequential effects.\n\nObserve the site's agent-status feedback and pending/result/error UI. Read structured results and verify observable state before reporting success. An expected rejection is a valid negative test outcome, not a completed purchase, deletion, or other requested action.\n\n## Capability reference\n\n${agentCapabilityGuide(tools)}\n\n## Maintenance and future capabilities\n\nUpdate this guide when capabilities change. Add only source-grounded tool behavior, review the exact integration patch, and verify human and agent interactions. Preserve owner-authored sections outside WebMCPify's marked block. More capabilities can be documented here in future revisions. Public discovery files belong in the site's served assets, never in .webmcpify; that folder contains private local run evidence.`;
  const agents = await optionalText(workspace, "AGENTS.md");
  await workspaceWrite(workspace, "AGENTS.md", mergeSection(agents, `${repoGuide}\n\n${siteGuide}`, "# Repository and site agent guidance"));
  files.push("AGENTS.md");
  if (publicDirectory === undefined) {
    const file = "docs/webmcp-readiness.md";
    const section = `${repoGuide}\n\nNo root-served static directory was established. Configure your framework/server to serve llms.txt, webmcp.md, and robots.txt as real text files before claiming public discovery support. Preserve existing crawler policies.\n\nProposed tools: ${tools.map((tool) => publicText(tool.name)).join(", ")}.`;
    await workspaceWrite(workspace, file, mergeSection(await optionalText(workspace, file), section, "# Website agent readiness"));
    return { files: [...files, file] };
  }
  const doc = path.posix.join(publicDirectory, "webmcp.md");
  const llms = path.posix.join(publicDirectory, "llms.txt");
  const robots = path.posix.join(publicDirectory, "robots.txt");
  const capabilities = tools.map((tool) => `### ${publicText(tool.name)}\n\n${publicText(tool.description)}\n\nAuthentication: ${tool.security?.userAuthentication ?? "consult the application"}. ${tool.annotations.consequentialHint ? "Preserve the application's explicit confirmation." : "Use the application's normal interaction rules."}\n\nInputs: ${Object.keys(tool.parameters.properties).map(publicText).join(", ") || "none"}. Inspect the live tool schema for required fields and constraints.\n\nPreconditions: ${tool.behavior.preconditions.map(publicText).join("; ") || "consult the live application state"}.`).join("\n\n");
  const guidance = `## Browser capabilities\n\nThese capabilities are available only when their page and required state are active in a compatible WebMCP browser. Inspect document.modelContext.getTools() on the current page; this document is guidance, not a remote MCP endpoint or permission grant. Use the existing interface when WebMCP is unavailable.\n\n${capabilities}\n\n## Access and results\n\nRespect robots.txt, authentication, business rules, and human confirmation. Crawl access does not authorize tool execution. Check structured results and observable state; an expected business-rule rejection is not a completed action. Do not request secrets or credentials through tool inputs.`;
  await workspaceWrite(workspace, doc, mergeSection(await optionalText(workspace, doc), guidance, "# Browser capability guide"));
  const summary = `> Public guidance for using this website's browser capabilities.\n\nWebMCP requires a compatible browser and the current page's live tools. Existing authentication and consent still apply.\n\n## Capabilities\n\n- [Browser capability guide](./webmcp.md): Tool names, inputs, preconditions, and interaction boundaries.\n- [Crawler policy](./robots.txt): Existing crawl restrictions remain applicable.`;
  await workspaceWrite(workspace, llms, mergeSection(await optionalText(workspace, llms), summary, `# ${publicText(discovery.project.name ?? "Website")}`));
  const robotText = await optionalText(workspace, robots);
  const nativeRobots = discovery.sourceFiles.some((file) => /(?:^|\/)app\/robots\.[cm]?[jt]s$/.test(file));
  // Next metadata routes take ownership of /robots.txt. Don't add a colliding file.
  if (!nativeRobots) await workspaceWrite(workspace, robots, updateAgentRobots(robotText));
  return { publicDirectory, files: [...files, doc, llms, ...(!nativeRobots ? [robots] : [])] };
}
