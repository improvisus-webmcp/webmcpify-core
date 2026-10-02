import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { fixtureProvider } from "./fixture-provider.mjs";
import { runGenerate } from "../dist/commands/generate.js";
import { runReviewPrompt } from "../dist/commands/review.js";
import { runApply } from "../dist/commands/apply.js";
import { readPatchMetadata, readPendingPatch } from "../dist/lib/patches.js";
import { loadApprovedTasks, extractTasksFromText } from "../dist/lib/tasks.js";
import { withOperationSignal } from "../dist/lib/operation-context.js";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-partial-review-"));
const previousEnv = { ...process.env };
const source = "export function selectItem(){document.body.dataset.selected='true';}\nexport function dismissItem(){delete document.body.dataset.selected;}\nexport function clearItem(){document.body.dataset.selected='false';}\ndocument.querySelector('button')?.addEventListener('click', selectItem);\n";
const reviews = [];
const browserCheck = process.env.WEBMCPIFY_VERIFY_REVIEW_BROWSER === "1";
let browser;
let browserContext;
try {
  if (browserCheck) {
    const { chromium } = await import("playwright-core");
    browser = await chromium.connectOverCDP(process.env.WEBMCPIFY_CDP_URL);
    browserContext = await browser.newContext();
  }
  const provider = await fixtureProvider(root, "provider", `
import {appendFileSync,existsSync,readFileSync,writeFileSync,writeSync} from 'node:fs';
const selection = existsSync('.webmcpify/tool-selection.json') ? JSON.parse(readFileSync('.webmcpify/tool-selection.json','utf8')) : null;
if(selection)appendFileSync(${JSON.stringify(path.join(root, "revision-calls"))},'call\\n');
if(selection&&['success','repeat','tasks-only','reordered'].includes(process.env.PARTIAL_REVIEW_MODE))await new Promise(resolve=>setTimeout(resolve,process.env.WEBMCPIFY_VERIFY_REVIEW_BROWSER==='1'?3000:500));
const makeTool = (name,handler)=>({id:name,name,title:name,description:'Changes local selection state',parameters:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},security:{executionScope:'ui-state',userAuthentication:'none',agentIdentity:'none',authorization:'client-only',originScope:'same-origin',rateLimit:{enforced:false,scope:'agent-user-tool'},idempotency:{enforced:false},notes:'Browser local state only'},implementation:{handler:'src/app.js#'+handler,action:'change selection',state:'document.body.dataset.selected'},placement:{strategy:'imperative',file:'src/webmcp.js',rationale:'Loaded entry integration'},sourceFiles:['src/app.js'],behavior:{success:'Selection changes',preconditions:[],expectedFailures:[]}});
let tools=selection?selection.selected:[makeTool('select_item','selectItem'),makeTool('dismiss_item','dismissItem')];
if(!selection&&process.env.PARTIAL_REVIEW_MODE==='repeat')tools.push(makeTool('clear_item','clearItem'));
if(selection&&process.env.PARTIAL_REVIEW_MODE==='contract-drift')tools=tools.map(tool=>({...tool,description:'Changed contract'}));
if(selection&&process.env.PARTIAL_REVIEW_MODE==='reordered')tools=tools.map(tool=>Object.fromEntries(Object.entries(tool).reverse()));
if(selection&&process.env.PARTIAL_REVIEW_MODE==='provider-failure'){process.stderr.write('PRIVATE_REVIEW_PROVIDER_OUTPUT');process.exit(5);}
if(!selection)writeFileSync('src/app.js',readFileSync('src/app.js','utf8')+"\\nimport './webmcp.js';\\n");
const registrations=tools.map(tool=>"context.registerTool({name:"+JSON.stringify(tool.name)+",title:'Change selection',description:'Change selection',inputSchema:{type:'object',properties:{}},execute:()=>{ "+(tool.name==='select_item'?'selectItem':tool.name==='clear_item'?'clearItem':'dismissItem')+"();return {};}});").join('\\n');
const rejected=selection&&process.env.PARTIAL_REVIEW_MODE==='source-drift'?"context.registerTool({name:'dismiss_item',execute:dismissItem});":'';
writeFileSync('src/webmcp.js',"import {selectItem,dismissItem,clearItem} from './app.js';\\nconst context=document.modelContext;if(context){\\n"+registrations+rejected+"\\n}\\n");
const tasks=Array.from({length:5},(_,i)=>({id:'task_'+i,description:'Verify local selection',requiredTools:[tools[i%tools.length].name],verify:'document.body.dataset.selected === "true"'}));
const fence=String.fromCharCode(96).repeat(3);writeSync(1,[...(selection&&process.env.PARTIAL_REVIEW_MODE==='tasks-only'?[]:['TOOL_PROPOSALS_JSON',fence+'json',JSON.stringify({tools}),fence]),'TASKS_JSON',fence+'json',JSON.stringify(tasks),fence].join('\\n'));
`);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
  for (const mode of browserCheck ? ["repeat"] : ["success", "tasks-only", "reordered", "repeat", "source-drift", "contract-drift", "provider-failure"]) {
    process.env.PARTIAL_REVIEW_MODE = mode;
    const site = path.join(root, mode);
    await mkdir(path.join(site, "src"), { recursive: true });
    await writeFile(path.join(site, "src/app.js"), source);
    await writeFile(path.join(site, "index.html"), '<button onclick="selectItem()">Select</button><button onclick="dismissItem()">Dismiss</button>');
    await writeFile(path.join(site, ".gitignore"), ".webmcpify/\nnode_modules/\n");
    await writeFile(path.join(site, "package.json"), JSON.stringify({ name: "partial-fixture", type: "module", scripts: { build: "node --check src/app.js && node --check src/webmcp.js" } }));
    for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-qm", "baseline"]]) await execa("git", args, { cwd: site });
    try { await runGenerate({ path: site, provider: "opencode", productContextPrompt: false }); }
    catch (error) {
      const diagnostics = await readdir(path.join(site, ".webmcpify/trajectories"));
      const validation = diagnostics.find(name => /^generate-metadata-validation-.*\.json$/.test(name) && !name.endsWith(".meta.json"));
      if (validation) {
        const details = JSON.parse(await readFile(path.join(site, ".webmcpify/trajectories", validation), "utf8"));
        throw new Error(`Fixture generation failed validation: ${details.error}`, { cause: error });
      }
      throw error;
    }
    const original = await readPatchMetadata(site);
    assert.equal(original.securityPolicy, "balance");
    assert.equal(original.provider, "opencode");
    const originalPatch = await readPendingPatch(site, original);
    const tools = JSON.parse(await readFile(path.join(site, ".webmcpify/proposed-tools.json"), "utf8")).tools;
    const controller = new AbortController();
    const review = withOperationSignal(controller.signal, () => runReviewPrompt(site, "4390"));
    review.catch(() => {});
    reviews.push({ controller, review });
    const getPage = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const response = await fetch("http://127.0.0.1:4390"); if (response.ok) return await response.text(); } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Review server did not start");
    };
    const initialPage = await getPage();
    assert.match(initialPage, /Prepare selected-tool draft/);
    assert.doesNotMatch(initialPage, /name="(?:taskIds|tasksJson|toolsJson)"/);
    let currentMetadata = original;
    let confirmationToken = "";
    const form = (stage, selectedNames = ["select_item"]) => {
      const body = new URLSearchParams({ stage, reviewRunId: currentMetadata.runId, reviewPatchHash: currentMetadata.patchHash, confirmationToken, approveSourceDiff: "yes" });
      for (const name of selectedNames) body.append("toolIds", name);
      return body;
    };
    const post = body => fetch("http://127.0.0.1:4390/approve", { method: "POST", body });
    const waitForRevision = async () => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const status = await (await fetch("http://127.0.0.1:4390/review-status")).json();
        if (!["revising", "busy"].includes(status.state)) return status;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Revision did not finish");
    };
    const successful = ["success", "tasks-only", "reordered", "repeat"].includes(mode);
    const firstSelection = mode === "repeat" ? ["select_item", "clear_item"] : ["select_item"];
    let page;
    let secondPage;
    let selectedResponse;
    if (browserContext) {
      page = await browserContext.newPage();
      secondPage = await browserContext.newPage();
      await Promise.all([page.goto("http://127.0.0.1:4390"), secondPage.goto("http://127.0.0.1:4390")]);
      assert.equal(await page.locator('[name="taskIds"], [name="tasksJson"], [name="toolsJson"]').count(), 0);
      await page.locator('input[name="toolIds"][value="dismiss_item"]').uncheck();
      const response = page.waitForResponse(response => response.url().endsWith("/approve") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Prepare selected-tool draft" }).click();
      const actual = await response;
      const html = await actual.text();
      selectedResponse = { status: actual.status(), text: async () => html };
      await page.waitForFunction(() => document.body.getAttribute("aria-busy") === "true");
      await secondPage.waitForFunction(() => document.body.getAttribute("aria-busy") === "true");
      assert.ok(await secondPage.locator("form").evaluate(form => form.inert), "Other open tabs must lock during revision");
      assert.equal(await secondPage.locator("input:not(:disabled), button:not(:disabled), textarea:not(:disabled)").count(), 0);
      await secondPage.reload();
      assert.equal(await secondPage.locator("form, input, button, textarea").count(), 0, "Refreshing during revision must not reopen controls");
    } else selectedResponse = await post(form("prepare", firstSelection));
    assert.equal(selectedResponse.status, 202, "Revision must return a progress page immediately, not keep the POST open");
    if (successful) {
      const duplicate = await post(form("prepare", firstSelection));
      assert.equal(duplicate.status, 409, "Double submits must not launch overlapping revisions");
      const busyPage = await getPage();
      assert.match(busyPage, /Updating selected tools/);
      assert.doesNotMatch(busyPage, /<form|<input|<button|<textarea/);
      assert.equal((await fetch("http://127.0.0.1:4390/reject", { method: "POST" })).status, 409);
    }
    const selectedText = await selectedResponse.text();
    assert.doesNotMatch(selectedText, /PRIVATE_REVIEW_PROVIDER_OUTPUT/);
    assert.equal(await readFile(path.join(site, "src/app.js"), "utf8"), source, "Review must never change target source");
    await assert.rejects(readFile(path.join(site, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
    let status = await waitForRevision();
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_REVIEW_PROVIDER_OUTPUT/);
    if (successful) {
      assert.equal(status.state, "ready", JSON.stringify(status));
      assert.match(selectedText, /No approval has been created/);
      let revised = await readPatchMetadata(site);
      if (page) {
        await page.waitForFunction(runId => document.querySelector('[name="reviewRunId"]')?.value === runId, revised.runId);
        await secondPage.waitForFunction(runId => document.querySelector('[name="reviewRunId"]')?.value === runId, revised.runId);
        assert.equal(await page.locator('input[name="toolIds"]').count(), 2, "Busy page must automatically return to the revised selection");
      }
      if (mode === "repeat") {
        const firstRun = revised.runId;
        currentMetadata = revised;
        if (page) {
          await page.locator('input[name="toolIds"][value="clear_item"]').uncheck();
          await page.getByRole("button", { name: "Prepare selected-tool draft" }).click();
          await page.waitForFunction(() => document.body.getAttribute("aria-busy") === "true");
        } else assert.equal((await post(form("prepare"))).status, 202);
        status = await waitForRevision();
        assert.equal(status.state, "ready", JSON.stringify(status));
        revised = await readPatchMetadata(site);
        assert.notEqual(revised.runId, firstRun, "Repeated removals must create another new draft without reopening the server");
      }
      assert.notEqual(revised.runId, original.runId);
      assert.equal(revised.patchStatus, "awaiting-review");
      const revisedPatch = await readPendingPatch(site, revised);
      assert.doesNotMatch(revisedPatch, /name:\s*['"]dismiss_item/);
      const retained = JSON.parse(await readFile(path.join(site, ".webmcpify/proposed-tools.json"), "utf8")).tools;
      assert.deepEqual(retained.map(tool => tool.name), ["select_item"]);
      const tasks = extractTasksFromText(await readFile(revised.generationTrajectory, "utf8"));
      assert.ok(tasks.every(task => task.requiredTools.length === 1 && task.requiredTools[0] === "select_item"));
      await getPage();
      currentMetadata = original;
      const staleConfirm = await post(form("confirm"));
      assert.equal(staleConfirm.status, 400, "The old draft cannot confirm a new source patch");
      currentMetadata = revised;
      let confirmationPage;
      if (page) {
        await page.waitForFunction(runId => document.querySelector('[name="reviewRunId"]')?.value === runId, revised.runId);
        await page.locator('input[name="approveSourceDiff"]').check();
        await page.getByRole("button", { name: "Approve reviewed draft" }).click();
        await page.getByRole("button", { name: "Confirm Approval" }).waitFor();
        confirmationPage = await page.content();
      } else confirmationPage = await (await post(form("prepare"))).text();
      assert.match(confirmationPage, /Confirm Approval/);
      assert.match(confirmationPage, /margin-top:24px/);
      confirmationToken = confirmationPage.match(/name="confirmationToken" value="([^"]+)"/)[1];
      await assert.rejects(readFile(path.join(site, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
      if (page) {
        await page.getByRole("button", { name: "Confirm Approval" }).click();
        await page.getByRole("heading", { name: "Approved ✓" }).waitFor();
        assert.equal(await page.locator("form, input, button, textarea").count(), 0);
      } else {
        const confirm = await post(form("confirm"));
        assert.equal(confirm.status, 200, await confirm.text());
      }
      const result = await review;
      assert.deepEqual(result.tools, ["select_item"]);
      assert.deepEqual(await loadApprovedTasks(site), tasks);
      await runApply({ path: site });
      assert.match(await readFile(path.join(site, "src/webmcp.js"), "utf8"), /name:\s*["']select_item/);
      assert.doesNotMatch(await readFile(path.join(site, "src/webmcp.js"), "utf8"), /name:\s*["']dismiss_item/);
      assert.match(await readFile(path.join(site, "src/app.js"), "utf8"), /export function dismissItem/, "Rejecting a WebMCP tool must preserve its original app action");
      assert.doesNotMatch(await readFile(path.join(site, "AGENTS.md"), "utf8"), /dismiss_item/);
      for (const file of ["README.md", "webmcp.md", "webmcp.html"]) {
        const content = await readFile(path.join(site, file), "utf8");
        assert.match(content, /select_item/);
        assert.doesNotMatch(content, /dismiss_item/, `${file} must describe only retained tools`);
      }
    } else {
      assert.equal(status.state, "error");
      assert.match(status.message, /Could not revise/);
      assert.match(await getPage(), /role="alert"/);
      assert.equal(await readPendingPatch(site, original), originalPatch, "Failed revisions preserve the old pending patch");
      if (mode === "provider-failure") {
        process.env.PARTIAL_REVIEW_MODE = "tasks-only";
        assert.equal((await post(form("prepare"))).status, 202, "The same review server must allow retry after failure");
        assert.equal((await waitForRevision()).state, "ready");
        assert.notEqual((await readPatchMetadata(site)).runId, original.runId);
        await assert.rejects(readFile(path.join(site, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
      }
      controller.abort();
      await assert.rejects(review, /Review was cancelled/);
    }
    assert.ok((await readdir(path.join(site, ".webmcpify/trajectories"))).some(name => name.startsWith("review-selection-")));
  }
  const calls = (await readFile(path.join(root, "revision-calls"), "utf8")).trim().split("\n").length;
  assert.equal(calls, browserCheck ? 2 : 9, "Valid subset revisions should use one focused provider call each");
} finally {
  for (const { controller, review } of reviews) { controller.abort(); await review.catch(() => {}); }
  await browserContext?.close();
  await browser?.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  await rm(root, { recursive: true, force: true });
}
console.log("Partial review passed: rejected registrations omitted, approved-only tools/tasks/docs, original app behavior preserved, fresh exact-patch confirmation, fail-closed revision");
