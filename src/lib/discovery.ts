import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentPublicDirectory } from "./agent-readiness.js";

export interface DiscoverySignal {
  file: string;
  line?: number;
  kind: string;
  detail: string;
}

export interface DiscoveryResult {
  version: 1;
  discoveredAt: string;
  targetProject: string;
  project: { name?: string; description?: string };
  stack: {
    language: string[];
    framework?: string;
    frameworkVersion?: string;
    packageManager?: string;
  };
  routes: string[];
  sitemap: string[];
  robots?: string[];
  forms: DiscoverySignal[];
  buttons: DiscoverySignal[];
  actions: DiscoverySignal[];
  apis: DiscoverySignal[];
  authentication: DiscoverySignal[];
  state: DiscoverySignal[];
  existingWebMCP: DiscoverySignal[];
  capabilities: string[];
  sourceFiles: string[];
  filesScanned: number;
  agentReadiness?: { publicDirectory?: string; files: string[]; robotsPolicy?: string[] };
}

const EXCLUDED = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", "coverage", ".webmcpify"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".html", ".mjs", ".cjs", ".css", ".scss", ".go", ".py", ".rb", ".java", ".rs"]);

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (EXCLUDED.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, full));
    else if (!entry.name.endsWith(".d.ts") && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

function lineSignals(relative: string, content: string, patterns: Array<[string, RegExp]>): DiscoverySignal[] {
  const signals: DiscoverySignal[] = [];
  const lines = content.split(/\r?\n/);
  for (const [kind, pattern] of patterns) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) signals.push({ file: relative, line: index + 1, kind, detail: line.trim().slice(0, 240) });
      pattern.lastIndex = 0;
    });
  }
  return signals;
}

function routeFromFile(relative: string): string | undefined {
  const normalized = relative.replaceAll("\\", "/");
  const normalizeRoute = (value: string): string => value
    .replace(/\[\.\.\.([^\]]+)\]/g, ":$1*")
    .replace(/\[([^\]]+)\]/g, ":$1");
  const appFile = normalized.match(/(?:^|\/)(?:app|src\/app)\/(.*?)(?:\/)?(page|route)\.(?:tsx?|jsx?|vue|svelte|astro)$/);
  if (appFile && appFile[2] === "page") {
    return `/${normalizeRoute(appFile[1])}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  }
  const pagesFile = normalized.match(/(?:^|\/)(?:pages|src\/pages)\/(.*)\.(?:tsx?|jsx?|vue|svelte|astro)$/);
  if (!pagesFile || pagesFile[1].startsWith("_") || pagesFile[1].startsWith("api/")) return undefined;
  let route = pagesFile[1].replace(/\/index$/, "");
  route = normalizeRoute(route);
  return `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function dependencyVersion(packageJson: Record<string, unknown>, name: string): string | undefined {
  const dependencies = { ...(packageJson.dependencies as Record<string, string> | undefined), ...(packageJson.devDependencies as Record<string, string> | undefined) };
  return dependencies[name];
}

function detectFramework(packageJson: Record<string, unknown>): { name?: string; version?: string } {
  const candidates: Array<[string, string]> = [
    ["next", "Next.js"], ["@remix-run/react", "Remix"], ["react", "React"],
    ["vue", "Vue"], ["svelte", "Svelte"], ["astro", "Astro"], ["@angular/core", "Angular"],
    ["express", "Express"], ["fastify", "Fastify"], ["django", "Django"], ["flask", "Flask"],
  ];
  for (const [dependency, name] of candidates) {
    const version = dependencyVersion(packageJson, dependency);
    if (version) return { name, version };
  }
  return {};
}

function detectPackageManager(sitePath: string, packageJson: Record<string, unknown>): string | undefined {
  for (const [file, manager] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"], ["bun.lockb", "bun"], ["bun.lock", "bun"]] as const) {
    if (existsSync(path.join(sitePath, file))) return manager;
  }
  if (typeof packageJson.packageManager === "string") return packageJson.packageManager.split("@")[0];
  return undefined;
}

async function readOptional(sitePath: string, file: string): Promise<string | undefined> {
  try { return await readFile(path.join(sitePath, file), "utf8"); } catch { return undefined; }
}

export function discoveryPath(sitePath: string): string {
  return path.join(sitePath, ".webmcpify", "discovery.json");
}

export async function discoverProject(sitePath: string): Promise<DiscoveryResult> {
  const packageRaw = await readOptional(sitePath, "package.json");
  let parsedPackage: Record<string, unknown> = {};
  if (packageRaw) {
    try { parsedPackage = JSON.parse(packageRaw) as Record<string, unknown>; } catch { /* continue with filesystem signals */ }
  }
  const framework = detectFramework(parsedPackage);
  const readme = (await readOptional(sitePath, "README.md")) ?? (await readOptional(sitePath, "README"));
  const files = await walk(sitePath);
  const routes = new Set<string>();
  const sitemap: string[] = [];
  const robots: string[] = [];
  const forms: DiscoverySignal[] = [];
  const buttons: DiscoverySignal[] = [];
  const actions: DiscoverySignal[] = [];
  const apis: DiscoverySignal[] = [];
  const authentication: DiscoverySignal[] = [];
  const state: DiscoverySignal[] = [];
  const existingWebMCP: DiscoverySignal[] = [];

  for (const file of files) {
    const relative = path.relative(sitePath, file).split(path.sep).join("/");
    const content = await readFile(file, "utf8");
    // Styles belong in the source inventory, not in the executable capability signals.
    if (/\.(?:css|scss)$/i.test(relative) || (/\.html$/i.test(relative) && content.includes("<!-- webmcpify:capability-page -->"))) continue;
    const route = routeFromFile(relative);
    if (route) routes.add(route);
    forms.push(...lineSignals(relative, content, [["form", /<form\b|<input\b|<select\b|<textarea\b/i]]));
    buttons.push(...lineSignals(relative, content, [["button", /<button\b|type\s*=\s*["']submit|type\s*=\s*["']button/i]]));
    actions.push(...lineSignals(relative, content, [["event-handler", /on(?:Click|Submit|Change|Input|Press)\s*=|addEventListener\s*\(|\((?:click|ngSubmit|submit|change|input)\)\s*=/i], ["navigation", /navigate\(|router\.(?:push|replace)|<a\b|<Link\b|routerLink\s*=/i]]));
    apis.push(...lineSignals(relative, content, [["request", /\bfetch\s*\(|axios\.|\bgraphql\b|\/api\//i], ["handler", /app\.(?:get|post|put|patch|delete)\s*\(|export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b/i]]));
    authentication.push(...lineSignals(relative, content, [["authentication", /(?:signIn|signOut|login|logout|useAuth|session|currentUser|clerk|next-auth|supabase\.auth|firebase\.auth)/i]]));
    state.push(...lineSignals(relative, content, [["state", /useState\s*\(|useReducer\s*\(|createContext\s*\(|create\s*\(|zustand|redux|mobx|pinia|localStorage|sessionStorage|\bsignal\s*\(|FormGroup|FormControl|formControlName/i]]));
    existingWebMCP.push(...lineSignals(relative, content, [["webmcp", /document\.modelContext|navigator\.modelContext|registerTool\s*\(|useWebMCP|useWebMcp|use-webmcp-tool|webmcp-tools|toolName\s*:|\btoolname\s*=|attr\.toolname/i]]));
  }

  const sitemapRaw = await readOptional(sitePath, "public/sitemap.xml") ?? await readOptional(sitePath, "sitemap.xml");
  if (sitemapRaw) for (const match of sitemapRaw.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) sitemap.push(match[1].trim());
  const robotsRaw = await readOptional(sitePath, "public/robots.txt") ?? await readOptional(sitePath, "robots.txt");
  if (robotsRaw) for (const line of robotsRaw.split(/\r?\n/)) if (/^\s*(?:disallow|allow):/i.test(line)) robots.push(line.trim());

  const capabilitySet = new Set<string>();
  for (const key of Object.keys((parsedPackage.scripts as Record<string, unknown> | undefined) ?? {})) capabilitySet.add(`script:${key}`);
  if (forms.length) capabilitySet.add("forms");
  if (buttons.length) capabilitySet.add("buttons");
  if (apis.length) capabilitySet.add("apis");
  if (authentication.length) capabilitySet.add("authentication-signals");
  if (state.length) capabilitySet.add("state-management-signals");
  if (existingWebMCP.length) capabilitySet.add("existing-webmcp-signals");

  const languages = new Set<string>();
  if (existsSync(path.join(sitePath, "tsconfig.json")) || files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))) languages.add("TypeScript");
  if (existsSync(path.join(sitePath, "package.json")) || files.some((file) => /\.(?:js|jsx|mjs|cjs)$/.test(file))) languages.add("JavaScript");
  if (existsSync(path.join(sitePath, "requirements.txt")) || existsSync(path.join(sitePath, "pyproject.toml"))) languages.add("Python");
  if (existsSync(path.join(sitePath, "go.mod"))) languages.add("Go");
  if (existsSync(path.join(sitePath, "Cargo.toml"))) languages.add("Rust");
  if (existsSync(path.join(sitePath, "pom.xml"))) languages.add("Java");

  const result: DiscoveryResult = {
    version: 1,
    discoveredAt: new Date().toISOString(),
    targetProject: sitePath,
    project: { name: typeof parsedPackage.name === "string" ? parsedPackage.name : undefined, description: typeof parsedPackage.description === "string" ? parsedPackage.description : readme?.split(/\r?\n/).find((line) => line.trim())?.trim() },
    stack: { language: [...languages], framework: framework.name, frameworkVersion: framework.version, packageManager: detectPackageManager(sitePath, parsedPackage) },
    routes: [...new Set([...routes, ...sitemap.map((entry) => { try { return new URL(entry).pathname; } catch { return entry; } })])].sort(),
    sitemap: [...new Set(sitemap)],
    robots: robots.length ? [...new Set(robots)] : undefined,
    forms: forms.slice(0, 200), buttons: buttons.slice(0, 200), actions: actions.slice(0, 300), apis: apis.slice(0, 300), authentication: authentication.slice(0, 200), state: state.slice(0, 200), existingWebMCP: existingWebMCP.slice(0, 200), capabilities: [...capabilitySet].sort(), sourceFiles: files.map((file) => path.relative(sitePath, file).split(path.sep).join("/")).sort(), filesScanned: files.length,
  };
  const publicDirectory = await agentPublicDirectory(sitePath, result);
  const readinessPaths = ["AGENTS.md", ".agent.md", "angular.json", "docs/webmcp-readiness.md", ...[".", "public", "static", publicDirectory].filter((dir): dir is string => dir !== undefined).flatMap((dir) => ["llms.txt", "webmcp.md", "webmcp.html", "webmcp-capabilities.html", "robots.txt", "sitemap.xml"].map((file) => path.posix.join(dir, file)))];
  const robotsFile = publicDirectory !== undefined ? await readOptional(sitePath, path.join(publicDirectory, "robots.txt")) : robotsRaw;
  result.agentReadiness = { publicDirectory, files: [...new Set(readinessPaths)].filter((file) => existsSync(path.join(sitePath, file))), robotsPolicy: robotsFile?.split(/\r?\n/).filter((line) => /^\s*(?:User-agent|Allow|Disallow|Sitemap):/i.test(line)) };
  return result;
}

export async function writeDiscovery(sitePath: string, discovery: DiscoveryResult): Promise<string> {
  const output = discoveryPath(sitePath);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
  return output;
}

export async function runDiscovery(sitePath: string, persist = true): Promise<DiscoveryResult> {
  const discovery = await discoverProject(sitePath);
  if (persist) await writeDiscovery(sitePath, discovery);
  return discovery;
}
