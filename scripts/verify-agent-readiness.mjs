import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { discoverProject } from "../dist/lib/discovery.js";
import { agentPublicDirectory, updateAgentRobots, updateWebmcpifyGitignore, writeAgentReadiness } from "../dist/lib/agent-readiness.js";
import { fixtureProvider } from "./fixture-provider.mjs";
import { assertGeneratedFormFeedback, assertGeneratedWebMcpWiring, runGenerate } from "../dist/commands/generate.js";
import { readPatchMetadata } from "../dist/lib/patches.js";
import { projectDisplayName } from "../dist/lib/project-identity.js";
import { PreflightEnvironmentError } from "../dist/lib/preflight.js";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-readiness-"));
const previousProvider = process.env.WEBMCPIFY_OPENCODE_BIN;
const previousManager = process.env.WEBMCPIFY_PACKAGE_MANAGER;
try {
  for (const existing of ["", "node_modules/", "# Owner rules\r\nnode_modules/\r\n", ".webmcpify/\n!.webmcpify/\n!.webmcpify/**\n"]) {
    const updatedIgnore = updateWebmcpifyGitignore(existing);
    assert.ok(updatedIgnore.startsWith(existing), "Owner ignore rules must be preserved byte-for-byte");
    assert.ok(updatedIgnore.endsWith("/.webmcpify/" + (existing.includes("\r\n") ? "\r\n" : "\n")));
    assert.equal(updateWebmcpifyGitignore(updatedIgnore), updatedIgnore, "Ignore rules must regenerate idempotently");
  }
  assert.equal(updateWebmcpifyGitignore("node_modules/\n.webmcpify/\n"), "node_modules/\n.webmcpify/\n");
  const policy = "# Keep owner policy\nUser-agent: SearchBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin/\nDisallow: /api/\nSitemap: https://example.test/sitemap.xml\n\nUser-agent: TrainingBot\nDisallow: /\n";
  const updated = updateAgentRobots(policy);
  assert.match(updated, /User-agent: SearchBot\nDisallow: \/\n/);
  assert.match(updated, /User-agent: TrainingBot\nDisallow: \/\n/);
  assert.match(updated, /Disallow: \/admin\//);
  assert.match(updated, /Disallow: \/api\//);
  assert.match(updated, /Sitemap: https:\/\/example.test\/sitemap.xml/);
  assert.equal(updated.match(/Allow: \/llms.txt\$/g)?.length, 1);
  assert.doesNotMatch(updated, /^Allow: \/$/m);
  assert.equal(updateAgentRobots(updated), updated);
  assert.doesNotMatch(updateAgentRobots("User-agent: *\nDisallow: /llms.txt\n"), /Allow: \/llms.txt/);
  const mixedPolicy = "User-agent: *\nUser-agent: Crawler\nDisallow: /\n";
  const mixedUpdated = updateAgentRobots(mixedPolicy);
  assert.ok(mixedUpdated.startsWith(mixedPolicy + "\nUser-agent: *\n"), "Named crawler rules must not receive new allowances");
  assert.equal(updateAgentRobots(mixedUpdated), mixedUpdated);
  assert.doesNotMatch(updateAgentRobots("User-agent: *\nDisallow: /\n\nUser-agent: *\nDisallow: /llms*\n"), /Allow: \/llms.txt/);
  assert.doesNotMatch(updateAgentRobots("User-agent: *\nDisallow: /*.md$\n"), /Allow: \/webmcp.md/);

  // Use a fixture provider, never cloud credentials, to exercise the real generation pipeline.
  const provider = await fixtureProvider(root, "provider", `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
appendFileSync(${JSON.stringify(path.join(root, "provider-calls"))}, 'call\\n');
const discovery = JSON.parse(readFileSync('.webmcpify/discovery.json', 'utf8'));
const ts = discovery.stack.language.includes('TypeScript');
const ext = ts ? 'ts' : 'js';
const original = 'src/app.' + ext;
const registration = 'src/webmcp.' + ext;
const nl = String.fromCharCode(10);
const metadataPass=process.argv.some(arg=>arg.includes('This is a read-only metadata pass'));
if(!metadataPass)writeFileSync(original, readFileSync(original, 'utf8') + "\\nimport './webmcp.js';\\n");
const typed = ts ? 'interface Context { registerTool(tool: { name: string; title: string; description: string; inputSchema: object; execute: () => object }, options: { signal: AbortSignal }): Promise<void> }\\n' : '';
const context = ts ? '(document as Document & { modelContext?: Context }).modelContext' : 'document.modelContext';
if(!metadataPass)writeFileSync(registration, typed + "import { selectItem } from './app.js';\\nconst context = " + context + ";\\nif (context) { const controller = new AbortController(); context.registerTool({ name: 'select_item', title: 'Select item', description: 'Selects an item in local UI state', inputSchema: {type: 'object', properties: {}, additionalProperties: false}, execute: () => { selectItem(); return { selected: true }; } }, {signal: controller.signal}); }\\n");
const tool = { id:'select_item',name:'select_item',title:'Select item',description:'Selects an item in local UI state',parameters:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},security:{executionScope:'ui-state',userAuthentication:'none',agentIdentity:'none',authorization:'client-only',originScope:'same-origin',rateLimit:{enforced:false,scope:'agent-user-tool'},idempotency:{enforced:false},notes:'Only the local document selection changes.'},implementation:{handler:original+'#selectItem',action:'select item',state:'document.body.dataset.selected'},behavior:{success:'The item is selected',preconditions:[],expectedFailures:[]},placement:{strategy:'imperative',file:registration,rationale:'Registered from the actual application entry'},sourceFiles:[original]};
const tasks = Array.from({length:5},(_,i)=>({id:'select_'+i,description:'Select item and verify local state',expectedOutcome:'success',requiredTools:['select_item'],verify:'document.body.dataset.selected === "true"'}));
const fence = String.fromCharCode(96).repeat(3);
const payload = ['TOOL_PROPOSALS_JSON', fence+'json', JSON.stringify({tools:[tool]}), fence, 'TASKS_JSON', fence+'json', JSON.stringify(tasks), fence].join(nl);
writeSync(1, payload);
`);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  // A plain npm/JS target without a lockfile must not depend on pnpm being installed.
  delete process.env.WEBMCPIFY_PACKAGE_MANAGER;
  for (const language of ["js", "ts"]) {
    const site = path.join(root, language);
    await mkdir(path.join(site, "src"), { recursive: true });
    await mkdir(path.join(site, "node_modules/.bin"), { recursive: true });
    const sourceFile = `src/app.${language}`;
    const source = "export function selectItem() { document.body.dataset.selected = 'true'; }\ndocument.querySelector('button')?.addEventListener('click', selectItem);\n";
    await writeFile(path.join(site, sourceFile), source);
    await writeFile(path.join(site, "index.html"), '<button onclick="selectItem()">Select</button>');
    const build = language === "js" ? "node --check src/app.js && node --check src/webmcp.js" : "tsc -p tsconfig.json";
    await writeFile(path.join(site, "package.json"), JSON.stringify({ name: `readiness-${language}`, type: "module", scripts: { build } }));
    const ownerIgnore = language === "js" ? "# Owner rules\nnode_modules/\n" : "node_modules/\n.webmcpify/\n";
    await writeFile(path.join(site, ".gitignore"), ownerIgnore);
    if (language === "ts") {
      await writeFile(path.join(site, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src"] }));
      if (process.platform === "win32") await writeFile(path.join(site, "node_modules/.bin/tsc.cmd"), `@"${process.execPath}" "${path.resolve("node_modules/typescript/bin/tsc")}" %*\r\n`);
      else await symlink(path.resolve("node_modules/typescript/bin/tsc"), path.join(site, "node_modules/.bin/tsc"));
    } else {
      // A transitive tsc binary must not make a JavaScript repo run a TS build.
      const fakeTsc = path.join(site, "node_modules/.bin/tsc");
      await writeFile(fakeTsc, '#!/usr/bin/env node\nprocess.exit(93);\n');
      await chmod(fakeTsc, 0o755);
    }
    await execa("git", ["init", "-q"], { cwd: site });
    await execa("git", ["config", "user.email", "fixture@example.invalid"], { cwd: site });
    await execa("git", ["config", "user.name", "Readiness fixture"], { cwd: site });
    await execa("git", ["add", "-A"], { cwd: site });
    await execa("git", ["commit", "-qm", "baseline"], { cwd: site });
    await runGenerate({ path: site, provider: "opencode", security: "strict", productContextPrompt: false });
    const metadata = await readPatchMetadata(site);
    assert.equal(metadata.patchStatus, "awaiting-review");
    const patch = await readFile(metadata.patchPath, "utf8");
    assert.ok(!metadata.changedFiles.includes(".gitignore"), "Housekeeping ignore rules must be initialized before the source baseline, not delayed until review");
    assert.equal(await readFile(path.join(site, ".gitignore"), "utf8"), updateWebmcpifyGitignore(ownerIgnore));
    for (const file of ["AGENTS.md", "README.md", "docs/webmcp-readiness.md", "webmcp.html", "llms.txt", "webmcp.md", "robots.txt", `src/webmcp.${language}`]) assert.ok(metadata.changedFiles.includes(file), `${file} must be bound to the reviewed patch`);
    assert.ok(!metadata.changedFiles.includes(".agent.md"), "Generate only one combined agent guide");
    assert.ok(!metadata.changedFiles.some((file) => file.startsWith(".webmcpify/")), "Site guidance must never enter private run state");
    assert.match(patch, /select_item/);
    for (const section of ["## WebMCP integration", "## Using the site as an agent", "## Capability reference", "improvisus/webmcpify"]) assert.ok(patch.includes(section), `The reviewed AGENTS.md must include ${section}`);
    assert.match(patch, /Allow: \/llms.txt\$/);
    assert.equal(await readFile(path.join(site, sourceFile), "utf8"), source, "The real target must stay unchanged before approval");
    await assert.rejects(readFile(path.join(site, "llms.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(site, ".agent.md")), { code: "ENOENT" });
    if (language === "js") assert.ok(!metadata.changedFiles.some((file) => /\.tsx?$/.test(file)));
  }

  const beforeMissingManager = (await readFile(path.join(root, "provider-calls"), "utf8")).split("\n").filter(Boolean).length;
  process.env.WEBMCPIFY_PACKAGE_MANAGER = path.join(root, "missing-manager");
  await assert.rejects(runGenerate({ path: path.join(root, "js"), provider: "opencode", productContextPrompt: false }), PreflightEnvironmentError);
  assert.equal((await readFile(path.join(root, "provider-calls"), "utf8")).split("\n").filter(Boolean).length, beforeMissingManager + 3, "Source/tools/tasks passes run, but a missing package manager must not trigger an LLM source repair");
  delete process.env.WEBMCPIFY_PACKAGE_MANAGER;
  const layouts = path.join(root, "layouts");
  await mkdir(layouts);
  const base = { stack: { framework: "Angular", language: ["TypeScript"] }, sourceFiles: [], apis: [], project: { name: "Site" } };
  await writeFile(path.join(layouts, "angular.json"), JSON.stringify({ projects: { site: { architect: { build: { options: { assets: [{ glob: "**/*", input: "public", output: "/" }] } } } } } }));
  assert.equal(await agentPublicDirectory(layouts, base), "public");
  await writeFile(path.join(layouts, "angular.json"), JSON.stringify({ projects: { site: { architect: { build: { options: { assets: ["src/assets"] } } } } } }));
  assert.equal(await agentPublicDirectory(layouts, base), undefined, "Angular /assets is not the origin root");
  assert.equal(await agentPublicDirectory(layouts, { ...base, stack: { framework: "Svelte" } }), "static");
  await writeFile(path.join(layouts, "vite.config.js"), "export default { publicDir: 'assets-public' }");
  assert.equal(await agentPublicDirectory(layouts, { ...base, stack: { framework: "React" } }), "assets-public");
  await writeFile(path.join(layouts, "vite.config.js"), "export default { root: 'frontend', publicDir: 'assets-public' }");
  assert.equal(await agentPublicDirectory(layouts, { ...base, stack: { framework: "React" } }), "frontend/assets-public");
  await writeFile(path.join(layouts, "vite.config.js"), "export default { publicDir: 'C:/outside' }");
  assert.equal(await agentPublicDirectory(layouts, { ...base, stack: { framework: "React" } }), undefined);
  await writeFile(path.join(layouts, "vite.config.js"), "export default { publicDir: false }");
  assert.equal(await agentPublicDirectory(layouts, { ...base, stack: { framework: "React" } }), undefined);
  await rm(path.join(layouts, "vite.config.js"));
  await mkdir(path.join(layouts, "public"));
  await writeFile(path.join(layouts, "AGENTS.md"), "# Owner guidance\nKeep these instructions.\n<!-- webmcpify:begin -->\nOld repository-only guidance\n<!-- webmcpify:end -->\nRetain owner capability notes.\n");
  const legacyOwnerGuide = "# Owner site guide\nRetain this existing owner file unchanged.\n";
  await writeFile(path.join(layouts, ".agent.md"), legacyOwnerGuide);
  await writeFile(path.join(layouts, "public/llms.txt"), "# Owner site\n\n> Owner summary\n\n## Existing\n\n- [Docs](https://example.test/docs)\n");
  const tool = { name: "filter", title: "Filter items", description: "Filters locally", annotations: { readOnlyHint: false, consequentialHint: false }, security: { executionScope: "ui-state", userAuthentication: "none", notes: "PRIVATE_INTERNAL_NOTE" }, parameters: { properties: { query: { type: "string", maxLength: 80, default: "PRIVATE_VALUE" } }, required: ["query"] }, behavior: { success: "Visible items match the query", preconditions: ["Open the item list"], expectedFailures: [{ condition: "Query is too long", error: "Query exceeds 80 characters" }] } };
  const readiness = await writeAgentReadiness(layouts, { ...base, stack: { framework: "React", language: ["JavaScript"] } }, [tool]);
  const html = await readFile(path.join(layouts, "public/webmcp.html"), "utf8");
  assert.match(html, /<h1>Site: browser-agent capabilities<\/h1>/);
  assert.match(html, /<title>Site — browser capabilities<\/title>/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /Query exceeds 80 characters/);
  assert.match(html, /Improvisus/);
  assert.doesNotMatch(html, /PRIVATE_INTERNAL_NOTE|PRIVATE_VALUE|canonical/);
  const beforeRegeneration = await Promise.all(readiness.files.map((file) => readFile(path.join(layouts, file), "utf8")));
  await writeAgentReadiness(layouts, { ...base, stack: { framework: "React", language: ["JavaScript"] } }, [tool]);
  assert.deepEqual(await Promise.all(readiness.files.map((file) => readFile(path.join(layouts, file), "utf8"))), beforeRegeneration, "All managed readiness files must regenerate idempotently");
  assert.equal(projectDisplayName({ project: {}, targetProject: path.join(root, "coffee-store") }), "coffee-store");
  const htmlOwner = "<!doctype html><title>Owner capability page</title>";
  await writeFile(path.join(layouts, "public/webmcp.html"), htmlOwner);
  await writeFile(path.join(layouts, "README.md"), "# Owner README\nKeep this description.\n");
  const identity = 'Site </script><img src=x onerror="alert(1)">';
  const alternate = await writeAgentReadiness(layouts, { ...base, project: { name: identity }, stack: { framework: "React", language: ["JavaScript"] } }, [tool]);
  assert.ok(alternate.files.includes("public/webmcp-capabilities.html"));
  assert.equal(await readFile(path.join(layouts, "public/webmcp.html"), "utf8"), htmlOwner);
  const escapedPage = await readFile(path.join(layouts, "public/webmcp-capabilities.html"), "utf8");
  assert.doesNotMatch(escapedPage, /<img src=x/);
  const jsonLd = escapedPage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(jsonLd).name, `${identity} — browser capabilities`);
  assert.match(await readFile(path.join(layouts, "README.md"), "utf8"), /Keep this description/);
  assert.match(await readFile(path.join(layouts, "public/llms.txt"), "utf8"), /\.\/webmcp-capabilities.html/);
  await writeFile(path.join(layouts, "public/webmcp-capabilities.html"), htmlOwner);
  const bothOwned = await writeAgentReadiness(layouts, { ...base, stack: { framework: "React", language: ["JavaScript"] } }, [tool]);
  assert.ok(!bothOwned.files.some((file) => file.endsWith(".html")), "Do not overwrite either owner HTML page");
  const noPage = await readFile(path.join(layouts, "public/llms.txt"), "utf8");
  assert.doesNotMatch(noPage, /Readable capability page/);
  const documentationOnlyDiff = 'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-Old\n+Use document.modelContext.registerTool\n';
  await assert.rejects(assertGeneratedWebMcpWiring(layouts, { sourceFiles: [] }, documentationOnlyDiff), /no current WebMCP runtime wiring/, "Documentation must not satisfy runtime wiring checks");
  assert.ok(readiness.files.includes("AGENTS.md"));
  assert.ok(!readiness.files.includes(".agent.md"));
  const llms = await readFile(path.join(layouts, "public/llms.txt"), "utf8");
  const doc = await readFile(path.join(layouts, "public/webmcp.md"), "utf8");
  assert.match(llms, /Owner summary/);
  assert.match(llms, /https:\/\/example.test\/docs/);
  assert.doesNotMatch(doc, /PRIVATE_INTERNAL_NOTE|PRIVATE_VALUE/);
  const agentGuide = await readFile(path.join(layouts, "AGENTS.md"), "utf8");
  for (const detail of ["Keep these instructions", "Retain owner capability notes", "## WebMCP integration", "## Using the site as an agent", "improvisus/webmcpify", "document.modelContext", "query: string; required; maxLength: 80", "Open the item list", "Visible items match the query", "Query exceeds 80 characters", "future revisions"]) assert.ok(agentGuide.includes(detail), `Combined agent guide must include ${detail}`);
  assert.doesNotMatch(agentGuide, /PRIVATE_INTERNAL_NOTE|PRIVATE_VALUE|Old repository-only guidance|\.agent\.md/);
  assert.equal(agentGuide.match(/<!-- webmcpify:begin -->/g)?.length, 1);
  assert.equal(agentGuide.match(/<!-- webmcpify:end -->/g)?.length, 1);
  assert.equal(await readFile(path.join(layouts, ".agent.md"), "utf8"), legacyOwnerGuide, "Do not overwrite or delete an existing owner file");
  await assert.rejects(readFile(path.join(layouts, ".webmcpify/AGENTS.md")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(layouts, ".webmcpify/llms.txt")), { code: "ENOENT" });
  await writeAgentReadiness(layouts, { ...base, stack: { framework: "React", language: ["JavaScript"] } }, [tool]);
  assert.equal(await readFile(path.join(layouts, "public/llms.txt"), "utf8"), llms);
  assert.equal(await readFile(path.join(layouts, "AGENTS.md"), "utf8"), agentGuide);
  assert.equal(await readFile(path.join(layouts, ".agent.md"), "utf8"), legacyOwnerGuide);
  assert.ok((await discoverProject(layouts)).agentReadiness.files.includes("AGENTS.md"));
  const robotsBefore = await readFile(path.join(layouts, "public/robots.txt"), "utf8");
  const native = await writeAgentReadiness(layouts, { ...base, sourceFiles: ["src/app/robots.ts"], stack: { framework: "Next.js", language: ["TypeScript"] } }, [tool]);
  assert.ok(!native.files.includes("public/robots.txt"), "A native metadata route owns /robots.txt");
  assert.equal(await readFile(path.join(layouts, "public/robots.txt"), "utf8"), robotsBefore);
  const fallback = await writeAgentReadiness(layouts, base, [tool]);
  assert.equal(fallback.publicDirectory, undefined);
  assert.ok(fallback.files.includes("AGENTS.md"), "Detailed guidance is available even without established public deployment");
  assert.ok(!fallback.files.includes(".agent.md"));
  assert.match(await readFile(path.join(layouts, "docs/webmcp-readiness.md"), "utf8"), /No root-served static directory/);
  const fresh = path.join(root, "fresh-guide");
  await mkdir(fresh);
  await writeAgentReadiness(fresh, base, [tool]);
  assert.match(await readFile(path.join(fresh, "AGENTS.md"), "utf8"), /## WebMCP integration[\s\S]*## Capability reference[\s\S]*Query exceeds 80 characters/);
  await assert.rejects(readFile(path.join(fresh, ".agent.md")), { code: "ENOENT" });
  const linked = path.join(root, "linked");
  const outside = path.join(root, "owner-guidance.md");
  await mkdir(linked);
  await writeFile(outside, "Owner file must stay untouched");
  if (process.platform === "win32") {
    const outsideDirectory = path.join(root, "owner-public");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(linked, "public"), "junction");
    await assert.rejects(writeAgentReadiness(linked, { ...base, stack: { framework: "React", language: ["JavaScript"] } }, [tool]), /symlink/);
  } else {
    await symlink(outside, path.join(linked, "AGENTS.md"));
    await assert.rejects(writeAgentReadiness(linked, base, [tool]), /symlink/);
  }
  assert.equal(await readFile(outside, "utf8"), "Owner file must stay untouched");
  const broken = path.join(root, "broken-markers");
  await mkdir(broken);
  const brokenOwner = "Owner text\n<!-- webmcpify:begin -->\nIncomplete owner section\n";
  await writeFile(path.join(broken, "AGENTS.md"), brokenOwner);
  await assert.rejects(writeAgentReadiness(broken, base, [tool]), /incomplete or duplicate/);
  assert.equal(await readFile(path.join(broken, "AGENTS.md"), "utf8"), brokenOwner);
  for (const malformed of [
    "Owner text\n<!-- webmcpify:end -->\n<!-- webmcpify:begin -->\nOld guide\n<!-- webmcpify:end -->\n",
    "Owner text\n<!-- webmcpify:begin -->\nOld guide\n<!-- webmcpify:begin -->\n<!-- webmcpify:end -->\n",
    "Owner text\n<!-- webmcpify:end -->\n<!-- webmcpify:begin -->\n",
  ]) {
    await writeFile(path.join(broken, "AGENTS.md"), malformed);
    await assert.rejects(writeAgentReadiness(broken, base, [tool]), /incomplete or duplicate/);
    assert.equal(await readFile(path.join(broken, "AGENTS.md"), "utf8"), malformed);
  }

  const formSite = path.join(root, "forms");
  const incompleteForms = path.join(root, "incomplete-forms");
  await mkdir(incompleteForms);
  await writeFile(path.join(incompleteForms, "filter.html"), '<form toolname="filter_coffee_roast"><input name="roast" /></form>');
  await writeFile(path.join(incompleteForms, "search.html"), '<form toolname="search"><input name="query" /></form>');
  await assert.rejects(assertGeneratedFormFeedback(incompleteForms, [
    { name: "filter_coffee_roast", placement: { strategy: "declarative", file: "filter.html" } },
    { name: "search", placement: { strategy: "declarative", file: "search.html" } },
  ]), (error) => {
    assert.match(error.message, /loaded styles/);
    for (const [name, file] of [["filter_coffee_roast", "filter.html"], ["search", "search.html"]]) {
      assert.ok(error.message.includes(`form "${name}" in ${file} needs an accessible agent-status region`));
      assert.ok(error.message.includes(`form "${name}" in ${file} needs activation/submit feedback`));
    }
    return true;
  }, "One report must include missing CSS, status regions and event feedback for every form");
  await mkdir(formSite);
  await writeFile(path.join(formSite, "index.html"), '<form toolname="search" tooldescription="Search"><input name="query" /><p role="status" aria-live="polite"></p></form><script>document.modelContext?.addEventListener("toolactivated", () => {});</script>');
  const formTool = { name: "search", placement: { strategy: "declarative", file: "index.html" } };
  await assert.rejects(assertGeneratedFormFeedback(formSite, [formTool]), /loaded styles/);
  await writeFile(path.join(formSite, "webmcp.css"), '@supports selector(form:tool-form-active) { form:tool-form-active { outline: 2px solid blue; } }\n@supports selector(:tool-submit-active) { :tool-submit-active { outline: 2px solid blue; } }');
  await assert.rejects(assertGeneratedFormFeedback(formSite, [formTool]), /loaded styles/, "A dead CSS file must not satisfy feedback checks");
  await writeFile(path.join(formSite, "index.html"), '<link rel="stylesheet" href="webmcp.css" /><form toolname="search" tooldescription="Search"><input name="query" /><p role="status" aria-live="polite"></p></form><script>document.modelContext?.addEventListener("toolactivated", () => {});</script>');
  await assertGeneratedFormFeedback(formSite, [formTool]);
  const discovered = await discoverProject(formSite);
  assert.ok(discovered.existingWebMCP.some((signal) => signal.detail.includes('toolname="search"')));
  await writeFile(path.join(formSite, "selectors.css"), 'form[toolname="search"] { color: blue; }');
  const stylesDiscovered = await discoverProject(formSite);
  assert.ok(stylesDiscovered.sourceFiles.includes("selectors.css"));
  assert.ok(!stylesDiscovered.existingWebMCP.some((signal) => signal.file.endsWith(".css")), "CSS selectors are not registrations");
  await writeFile(path.join(formSite, "index.html"), '<form toolname="search" tooldescription="Search"><input /></form><link href="webmcp.css" /><script>const agentInvoked = true;</script>');
  await assert.rejects(assertGeneratedFormFeedback(formSite, [formTool]), /accessible agent-status/);
  await writeFile(path.join(formSite, "search.component.html"), '<form [attr.toolname]="toolName" (ngSubmit)="submit()"><input formControlName="query" /><p role="status">{{agentStatus}}</p></form>');
  await writeFile(path.join(formSite, "search.component.ts"), "const view = { templateUrl: './search.component.html', styleUrl: './webmcp.css' }; const query = new FormControl(''); const agentInvoked = true;");
  await assertGeneratedFormFeedback(formSite, [{ ...formTool, placement: { strategy: "declarative", file: "search.component.html" } }]);
  const angularDiscovery = await discoverProject(formSite);
  assert.ok(angularDiscovery.actions.some((signal) => signal.file === "search.component.html"));
  assert.ok(angularDiscovery.state.some((signal) => signal.detail.includes("FormControl")));
  await writeFile(path.join(formSite, "Search.jsx"), 'import "./webmcp.css"; export function Search() { return <form toolname="search"><p role="status" aria-live="polite">{agentStatus}</p></form>; }');
  await assertGeneratedFormFeedback(formSite, [{ ...formTool, placement: { strategy: "declarative", file: "Search.jsx" } }]);
  console.log("Agent-readiness verification passed: JS/TS generation, one combined AGENTS.md, owner preservation, strict UI scope, reviewed metadata, crawler preservation, framework layouts, and loaded form feedback");
} finally {
  if (previousProvider === undefined) delete process.env.WEBMCPIFY_OPENCODE_BIN; else process.env.WEBMCPIFY_OPENCODE_BIN = previousProvider;
  if (previousManager === undefined) delete process.env.WEBMCPIFY_PACKAGE_MANAGER; else process.env.WEBMCPIFY_PACKAGE_MANAGER = previousManager;
  await rm(root, { recursive: true, force: true });
}
