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
if(selection&&['tasks-only','reordered','coverage-gap','provider-failure'].includes(process.env.PARTIAL_REVIEW_MODE))await new Promise(resolve=>setTimeout(resolve,process.env.WEBMCPIFY_VERIFY_REVIEW_BROWSER==='1'?6500:500));
const makeTool = (name,handler)=>({id:name,name,title:name,description:'Changes local selection state',parameters:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},security:{executionScope:'ui-state',userAuthentication:'none',agentIdentity:'none',authorization:'client-only',originScope:'same-origin',rateLimit:{enforced:false,scope:'agent-user-tool'},idempotency:{enforced:false},notes:'Browser local state only'},implementation:{handler:'src/app.js#'+handler,action:'change selection',state:'document.body.dataset.selected'},placement:{strategy:'imperative',file:'src/webmcp.js',rationale:'Loaded entry integration'},sourceFiles:['src/app.js'],behavior:{success:'Selection changes',preconditions:[],expectedFailures:[]}});
let tools=selection?selection.selected:[makeTool('select_item','selectItem'),makeTool('dismiss_item','dismissItem')];
if(!selection&&process.env.PARTIAL_REVIEW_MODE==='repeat')tools.push(makeTool('clear_item','clearItem'));
if(selection&&process.env.PARTIAL_REVIEW_MODE==='contract-drift')tools=tools.map(tool=>({...tool,description:'Changed contract'}));
if(selection&&process.env.PARTIAL_REVIEW_MODE==='reordered')tools=tools.map(tool=>Object.fromEntries(Object.entries(tool).reverse()));
if(selection&&process.env.PARTIAL_REVIEW_MODE==='provider-failure'){process.stderr.write('PRIVATE_REVIEW_PROVIDER_OUTPUT');process.exit(5);}
if(!selection)writeFileSync('src/app.js',readFileSync('src/app.js','utf8')+"\\nimport './webmcp.js';\\n");
const registrations=tools.map(tool=>"context.registerTool({name:"+JSON.stringify(tool.name)+",title:'Change selection',description:'Change selection',inputSchema:{type:'object',properties:{}},execute:()=>{ "+(tool.name==='select_item'?'selectItem':tool.name==='clear_item'?'clearItem':'dismissItem')+"();return {};}});").join('\\n');
const rejected=selection&&process.env.PARTIAL_REVIEW_MODE==='source-drift'?"context.registerTool({name:'dismiss_item',execute:dismissItem});":'';
const entangled=!selection&&['tasks-only','reordered','provider-failure','source-drift','contract-drift'].includes(process.env.PARTIAL_REVIEW_MODE);
const sourceRegistrations=entangled?"const definitions=["+tools.map(tool=>"{name:"+JSON.stringify(tool.name)+",execute:"+(tool.name==='select_item'?'selectItem':'dismissItem')+"}").join(',')+"];definitions.forEach(tool=>context.registerTool(tool));":registrations;
const imports=selection&&process.env.PARTIAL_REVIEW_MODE==='unused-integration'?'selectItem':'selectItem,dismissItem,clearItem';
if(!selection?.sourceAlreadyPruned)writeFileSync('src/webmcp.js',"import {"+imports+"} from './app.js';\\nconst context=document.modelContext;if(context){\\n"+sourceRegistrations+rejected+"\\n}\\n");
if(selection?.sourceAlreadyPruned&&process.env.PARTIAL_REVIEW_MODE==='task-only-drift')writeFileSync('src/webmcp.js',readFileSync('src/webmcp.js','utf8')+'\\n// forbidden task-only source edit\\n');
const gap=!selection&&['coverage-gap','task-only-drift'].includes(process.env.PARTIAL_REVIEW_MODE);
const tasks=Array.from({length:5},(_,i)=>({id:'task_'+i,description:'Verify local selection',requiredTools:gap?['dismiss_item','select_item']:[tools[i%tools.length].name],...(gap?{setup:'Reset selection with dismiss_item before selecting with select_item'}:{}),verify:'document.body.dataset.selected === "true"'}));
const fence=String.fromCharCode(96).repeat(3);writeSync(1,[...(selection&&process.env.PARTIAL_REVIEW_MODE==='tasks-only'?[]:['TOOL_PROPOSALS_JSON',fence+'json',JSON.stringify({tools}),fence]),'TASKS_JSON',fence+'json',JSON.stringify(tasks),fence].join('\\n'));
`);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
  for (const mode of browserCheck ? ["repeat", "provider-failure"] : ["success", "tasks-only", "reordered", "repeat", "coverage-gap", "unused-integration", "task-only-drift", "source-drift", "contract-drift", "provider-failure"]) {
    process.env.PARTIAL_REVIEW_MODE = mode;
    const site = path.join(root, mode);
    await mkdir(path.join(site, "src"), { recursive: true });
    await writeFile(path.join(site, "src/app.js"), source);
    await writeFile(path.join(site, "index.html"), '<button onclick="selectItem()">Select</button><button onclick="dismissItem()">Dismiss</button>');
    await writeFile(path.join(site, ".gitignore"), ".webmcpify/\nnode_modules/\n");
    await writeFile(path.join(site, "package.json"), JSON.stringify({ name: "partial-fixture", type: "module", scripts: { build: "node --check src/app.js && node --check src/webmcp.js" } }));
    if (mode === "unused-integration") {
      await mkdir(path.join(site, "node_modules"));
      await writeFile(path.join(site, "check.cjs"), "const text=require('node:fs').readFileSync('src/webmcp.js','utf8');if(text.includes('dismissItem,')&&!text.includes('name:'+JSON.stringify(['dismiss','item'].join('_')))){process.stderr.write('error TS6133: unused integration import');process.exit(1);}\n");
      await writeFile(path.join(site, "package.json"), JSON.stringify({ name: "partial-fixture", type: "module", scripts: { build: "node check.cjs" } }));
    }
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
    const originalTasks = extractTasksFromText(await readFile(original.generationTrajectory, "utf8"));
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
    const successful = ["success", "tasks-only", "reordered", "repeat", "coverage-gap", "unused-integration"].includes(mode);
    const firstSelection = mode === "repeat" ? ["select_item", "clear_item"] : ["select_item"];
    let page;
    let secondPage;
    let selectedResponse;
    const pageErrors = [];
    if (browserContext) {
      page = await browserContext.newPage();
      secondPage = await browserContext.newPage();
      page.on("pageerror", error => pageErrors.push(error.message));
      secondPage.on("pageerror", error => pageErrors.push(error.message));
      await Promise.all([page.goto("http://127.0.0.1:4390"), secondPage.goto("http://127.0.0.1:4390")]);
      const firstCard = page.locator(".grid > details.card").nth(0);
      const secondCard = page.locator(".grid > details.card").nth(1);
      const secondClosedHeight = (await secondCard.boundingBox()).height;
      await firstCard.locator("summary").click();
      assert.equal(await firstCard.evaluate(card => card.open), true);
      assert.equal(await secondCard.evaluate(card => card.open), false);
      assert.ok(Math.abs((await secondCard.boundingBox()).height - secondClosedHeight) < 1, "Opening one summary card must not visually expand the other");
      await firstCard.locator("summary").click();
      const firstClosedHeight = (await firstCard.boundingBox()).height;
      await secondCard.locator("summary").click();
      assert.equal(await firstCard.evaluate(card => card.open), false);
      assert.ok(Math.abs((await firstCard.boundingBox()).height - firstClosedHeight) < 1);
      await secondCard.locator("summary").click();
      assert.equal(await page.locator('[name="taskIds"], [name="tasksJson"], [name="toolsJson"]').count(), 0);
      assert.equal(await page.getByRole("button", { name: "Approve reviewed draft" }).isDisabled(), true, "Unchecked source consent must disable approval");
      assert.equal(await page.locator("tr[data-review-file]").count(), original.changedFiles.length);
      const tasksPanel = page.locator("details.review-panel").filter({ hasText: "3. Verification tasks" });
      assert.equal(await tasksPanel.evaluate(element => element.open), false);
      await tasksPanel.locator("summary").first().click();
      assert.equal(await tasksPanel.evaluate(element => element.open), true);
      await tasksPanel.locator("summary").first().click();
      assert.equal(await tasksPanel.evaluate(element => element.open), false);
      const sourceConsent = page.locator('input[name="approveSourceDiff"]');
      assert.ok((await sourceConsent.boundingBox()).width >= 28, "Consent checkbox must have a prominent touch target");
      await sourceConsent.check();
      assert.equal(await page.getByRole("button", { name: "Approve reviewed draft" }).isEnabled(), true);
      await sourceConsent.uncheck();
      assert.equal(await page.getByRole("button", { name: "Approve reviewed draft" }).isDisabled(), true);
      await sourceConsent.check();
      await page.locator('input[name="toolIds"][value="dismiss_item"]').uncheck();
      assert.equal(await sourceConsent.isDisabled(), true, "A reduced selection cannot consent to the old source patch");
      assert.equal(await sourceConsent.isChecked(), false, "Changing tools must discard existing source consent");
      await page.locator('input[name="toolIds"][value="dismiss_item"]').check();
      assert.equal(await sourceConsent.isEnabled(), true);
      assert.equal(await sourceConsent.isChecked(), false, "Restoring all tools must not restore old consent");
      await page.locator('input[name="toolIds"][value="dismiss_item"]').uncheck();
      assert.equal(await page.getByRole("button", { name: "Prepare selected-tool draft" }).isEnabled(), true, "Draft preparation is not consent to the original patch");
      const response = page.waitForResponse(response => response.url().endsWith("/approve") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Prepare selected-tool draft" }).click();
      const actual = await response;
      const html = await actual.text();
      selectedResponse = { status: actual.status(), text: async () => html };
      await page.waitForFunction(() => document.body.getAttribute("aria-busy") === "true");
      if (mode === "provider-failure") {
        await secondPage.waitForFunction(() => document.body.getAttribute("aria-busy") === "true");
        assert.equal(await secondPage.locator(".review-spinner").getAttribute("aria-hidden"), "true");
        assert.equal(await secondPage.locator(".review-spinner").evaluate(element => getComputedStyle(element).animationName), "review-spin", "Other-tab overlay must show live animation");
        assert.ok(await secondPage.locator("form").evaluate(form => form.inert), "Other open tabs must lock during revision");
        assert.equal(await secondPage.locator("input:not(:disabled), button:not(:disabled), textarea:not(:disabled)").count(), 0);
        await secondPage.reload();
        assert.equal(await secondPage.locator("form, input, button, textarea").count(), 0, "Refreshing during revision must not reopen controls");
        assert.equal(await secondPage.locator(".review-spinner").isVisible(), true);
        assert.equal(await secondPage.locator(".review-spinner").evaluate(element => getComputedStyle(element).animationName), "review-spin");
        await secondPage.waitForFunction(() => /Live status connected.*\d+s elapsed/.test(document.getElementById("activity")?.textContent ?? ""));
        const activity = await secondPage.locator("#activity").textContent();
        await secondPage.waitForFunction(previous => document.getElementById("activity")?.textContent !== previous, activity);
        await secondPage.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await secondPage.locator(".review-spinner").evaluate(element => getComputedStyle(element).animationName), "none", "Reduced-motion users still get text progress without animation");
        await secondPage.emulateMedia({ reducedMotion: "no-preference" });
      }
    } else selectedResponse = await post(form("prepare", firstSelection));
    assert.equal(selectedResponse.status, 202, "Revision must return a progress page immediately, not keep the POST open");
    if (["tasks-only", "reordered", "coverage-gap"].includes(mode)) {
      const duplicate = await post(form("prepare", firstSelection));
      assert.equal(duplicate.status, 409, "Double submits must not launch overlapping revisions");
      const busyPage = await getPage();
      assert.match(busyPage, /Updating selected tools/);
      assert.doesNotMatch(busyPage, /<form|<input|<button|<textarea/);
      assert.equal((await fetch("http://127.0.0.1:4390/reject", { method: "POST" })).status, 409);
    }
    const selectedText = await selectedResponse.text();
    assert.match(selectedText, /review-spinner/);
    assert.match(selectedText, /Reconnecting to Core/);
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
      assert.equal(revised.selectionRevision, true);
      const tasks = extractTasksFromText(await readFile(revised.generationTrajectory, "utf8"), 1);
      assert.ok(tasks.every(task => task.requiredTools.length === 1 && task.requiredTools[0] === "select_item"));
      if (mode !== "coverage-gap") assert.deepEqual(tasks, originalTasks.filter(task => task.requiredTools.every(name => name === "select_item")), "Unaffected tasks must retain IDs, setup, outcome, errors, and verification criteria exactly");
      assert.ok(tasks.length < 5, "Reduced drafts must not regenerate padding tests just to reach five");
      await getPage();
      currentMetadata = original;
      const staleConfirm = await post(form("confirm"));
      assert.equal(staleConfirm.status, 400, "The old draft cannot confirm a new source patch");
      currentMetadata = revised;
      let confirmationPage;
      if (page) {
        await page.waitForFunction(runId => document.querySelector('[name="reviewRunId"]')?.value === runId, revised.runId);
        assert.equal(await page.locator('input[name="approveSourceDiff"]').isChecked(), false, "Every revised patch must start with fresh, unchecked consent");
        assert.equal(await page.getByRole("button", { name: "Approve reviewed draft" }).isDisabled(), true);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Review must not overflow a mobile viewport");
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
        assert.match(status.message, /opencode.*could not complete/i);
        const failedPage = await getPage();
        assert.match(failedPage, /value="select_item" checked/);
        assert.doesNotMatch(failedPage, /value="dismiss_item" checked/);
        assert.match(failedPage, /aria-describedby="source-approval-help" disabled/, "Failed partial selection must render consent disabled before client scripts run");
        if (page) {
          await page.waitForFunction(() => document.querySelector('[role="alert"]') !== null);
          assert.equal(await page.locator('input[name="toolIds"][value="dismiss_item"]').isChecked(), false, "Rejected tools must remain unchecked after provider failure");
          assert.equal(await page.locator('input[name="approveSourceDiff"]').isDisabled(), true);
        }
        process.env.PARTIAL_REVIEW_MODE = "tasks-only";
        if (page) await page.getByRole("button", { name: "Prepare selected-tool draft" }).click();
        else assert.equal((await post(form("prepare"))).status, 202, "The same review server must allow retry after failure");
        assert.equal((await waitForRevision()).state, "ready");
        const recovered = await readPatchMetadata(site);
        assert.notEqual(recovered.runId, original.runId);
        if (page) {
          await page.waitForFunction(runId => document.querySelector('[name="reviewRunId"]')?.value === runId, recovered.runId);
          assert.equal(await page.locator('input[name="approveSourceDiff"]').isEnabled(), true);
          assert.equal(await page.locator('input[name="approveSourceDiff"]').isChecked(), false);
          assert.equal(await page.getByRole("button", { name: "Approve reviewed draft" }).isDisabled(), true);
        }
        await assert.rejects(readFile(path.join(site, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
      }
      controller.abort();
      await assert.rejects(review, /Review was cancelled/);
    }
    assert.ok((await readdir(path.join(site, ".webmcpify/trajectories"))).some(name => name.startsWith("review-selection-")));
    assert.deepEqual(pageErrors, [], "Review-to-progress replacements and fresh drafts must not redeclare script globals or throw browser errors");
  }
  const calls = (await readFile(path.join(root, "revision-calls"), "utf8")).trim().split("\n").length;
  assert.equal(calls, browserCheck ? 2 : 9, "Independent removals must use zero provider calls; entangled/coverage-gap/unused-integration revisions and explicit retries use focused calls");
} finally {
  for (const { controller, review } of reviews) { controller.abort(); await review.catch(() => {}); }
  await browserContext?.close();
  await browser?.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  await rm(root, { recursive: true, force: true });
}
console.log("Partial review passed: rejected registrations omitted, approved-only tools/tasks/docs, original app behavior preserved, fresh exact-patch confirmation, fail-closed revision");
