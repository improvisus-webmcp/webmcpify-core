import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTrajectoryArtifact } from "../dist/lib/trajectories.js";
import { runReviewPrompt } from "../dist/commands/review.js";
import { taskVerificationIssues } from "../dist/lib/tasks.js";
import { withOperationSignal } from "../dist/lib/operation-context.js";
import { writeProposedTools } from "../dist/lib/tool-proposals.js";
import { readPatchMetadata, readPendingPatch, sourcePatchHash } from "../dist/lib/patches.js";
import { describeReviewFiles } from "../dist/lib/review-files.js";
import { withCliProgress } from "../dist/lib/cli-progress.js";

function reviewReadiness() {
  let onReady;
  const ready = new Promise(resolve => { onReady = resolve; });
  return {
    onReady,
    wait: async review => {
      let timer;
      try {
        return await Promise.race([
          ready,
          review.then(() => { throw new Error("Review finished before its server became ready."); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Review server readiness timed out.")), 10_000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}

for (const isTTY of [false, true]) {
  let output = "";
  const options = { stream: { isTTY, write: text => { output += text; return true; } }, intervalMs: 10 };
  assert.equal(await withCliProgress("fixture", "Safe phase", async () => { await new Promise(resolve => setTimeout(resolve, 45)); return 42; }, options), 42);
  assert.match(output, /started/);
  assert.match(output, /elapsed/);
  assert.match(output, /completed/);
  if (isTTY) assert.match(output, /\x1b\[2K/); else assert.match(output, /working/);
  output = "";
  const failure = new Error("PRIVATE_PROMPT_CODE");
  await assert.rejects(withCliProgress("fixture", "Safe phase", async () => { throw failure; }, options), error => error === failure);
  assert.match(output, /stopped/);
  assert.doesNotMatch(output, /PRIVATE_PROMPT_CODE/);
  const stoppedOutput = output;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(output, stoppedOutput, "Progress timers must stop after errors");
}

const sitePath = await mkdtemp(path.join(os.tmpdir(), "webmcpify-review-"));
const sourceFile = path.join(sitePath, "src", "App.tsx");
await mkdir(path.dirname(sourceFile), { recursive: true });
await writeFile(sourceFile, "export function App() { return null; }\n");
const discovery = {
  version: 1, discoveredAt: new Date().toISOString(), targetProject: sitePath,
  project: { name: 'review-fixture <img src=x onerror="alert(1)">' }, stack: { language: ["TypeScript"], framework: "React" },
  routes: ["/"], sitemap: [], forms: [], buttons: [{ file: "src/App.tsx", kind: "button", detail: "<button>Run</button>" }],
  actions: [{ file: "src/App.tsx", kind: "event-handler", detail: "onClick={run}" }], apis: [], authentication: [], state: [], existingWebMCP: [],
  capabilities: ["buttons"], sourceFiles: ["src/App.tsx"], filesScanned: 1,
};
await mkdir(path.join(sitePath, ".webmcpify"), { recursive: true });
await writeFile(path.join(sitePath, ".webmcpify", "discovery.json"), `${JSON.stringify(discovery, null, 2)}\n`);
const tool = { id: "run_action", name: "run_action", title: "Run action", description: "Runs the discovered action.", parameters: { type: "object", properties: { idempotencyKey: { type: "string", maxLength: 80 } }, required: ["idempotencyKey"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false, consequentialHint: true }, security: { userAuthentication: "required", agentIdentity: "required", authorization: "backend", originScope: "same-origin", rateLimit: { enforced: true, scope: "agent-user-tool", limit: 3, windowSeconds: 86400 }, idempotency: { enforced: true, keyParameter: "idempotencyKey" }, notes: "The reviewed fixture represents backend enforcement." }, implementation: { handler: "src/App.tsx#run", action: "run the discovered action" }, behavior: { success: "The action completes.", preconditions: [], expectedFailures: [] }, placement: { strategy: "imperative", file: "src/App.tsx", rationale: "Keeps registration beside the action." }, sourceFiles: ["src/App.tsx"] };
await writeProposedTools(sitePath, [tool], "discovery.json", "fixture-generation.json");
const generationTasks = Array.from({ length: 5 }, (_, index) => ({ id: `task_${index + 1}`, description: `Check result ${index + 1}`, requiredTools: ["run_action"], verify: `document.querySelector("#result-${index + 1}") !== null` }));
const generation = await createTrajectoryArtifact("generate", JSON.stringify(generationTasks), { sitePath, provider: "fixture", fixture: true });
const runId = "review-fixture-run";
const additionalFiles = ["AGENTS.md", "README.md", "public/llms.txt", "public/webmcp.md", "public/webmcp.html", "public/robots.txt", "docs/webmcp-readiness.md", "src/webmcp.css", "src/config.js", "src/another.js", "public/<img src=x onerror=alert(1)>.txt"];
const changedFiles = ["src/App.tsx", ...additionalFiles];
const patch = "diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export function App() { return null; }\n+export function App() { return <button>Run</button>; }\n" + additionalFiles.map(file => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+Fixture content\n`).join("");
const fileDescriptions = describeReviewFiles(patch, [tool]);
assert.deepEqual(fileDescriptions.map(item => item.file), changedFiles, "Never cap the file list at ten");
assert.equal(fileDescriptions[0].change, "Modified");
assert.ok(fileDescriptions.slice(1).every(item => item.change === "Added" && item.reason));
assert.match(fileDescriptions[0].reason, /Keeps registration beside the action/);
assert.match(fileDescriptions.find(item => item.file === "src/config.js").reason, /No specific purpose/);
const removed = describeReviewFiles("diff --git a/old.js b/old.js\ndeleted file mode 100644\n--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n", []);
assert.equal(removed[0].change, "Deleted");
const renamed = describeReviewFiles('diff --git "a/old file.js" "b/new file.js"\nsimilarity index 100%\nrename from old file.js\nrename to new file.js\n', []);
assert.deepEqual(renamed.map(item => [item.file, item.change]), [["old file.js", "Renamed"], ["new file.js", "Renamed"]]);
await writeFile(path.join(sitePath, ".webmcpify", "pending-diff.patch"), patch);
await writeFile(path.join(sitePath, ".webmcpify", "pending-diff.meta.json"), `${JSON.stringify({ version: 1, runId, timestamp: new Date().toISOString(), targetProject: sitePath, changedFiles, patchStatus: "awaiting-review", patchPath: path.join(sitePath, ".webmcpify", "pending-diff.patch"), generationTrajectory: generation }, null, 2)}\n`);
const tasks = Array.from({ length: 5 }, (_, index) => ({ id: `task_${index + 1}`, description: `Check result ${index + 1}`, requiredTools: ["run_action"], verify: `document.querySelector("#result-${index + 1}") !== null` }));
assert.ok(taskVerificationIssues({ id: "bad_syntax", description: "Check the result", verify: "document.querySelector(" }).some((issue) => issue.severity === "error"));
assert.ok(taskVerificationIssues({ id: "trivial", description: "Check the result", verify: "true" }).some((issue) => issue.code === "trivial"));
assert.ok(taskVerificationIssues({ id: "missing_selector", description: "Check the result", verify: 'document.querySelector("#missing") !== null' }, { discovery }).some((issue) => issue.severity === "warning"));
let announcedReviewUrl;
const approvalReady = reviewReadiness();
const review = runReviewPrompt(sitePath, "4387", { fixture: true, durable: true }, { onReady: url => { announcedReviewUrl = url; approvalReady.onReady(url); } });
await approvalReady.wait(review);
const reviewHtml = await (await fetch("http://127.0.0.1:4387/approve")).text();
assert.equal(announcedReviewUrl, "http://127.0.0.1:4387", "Initial durable review uses new generated tasks, not nonexistent prior approval");
assert.match(reviewHtml, /Project: review-fixture &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.ok(reviewHtml.includes(sitePath));
assert.doesNotMatch(reviewHtml, /<img src=x onerror=/);
assert.doesNotMatch(reviewHtml, /name="(?:taskIds|tasksJson|toolsJson)"/);
assert.equal((reviewHtml.match(/<tr data-review-file=/g) ?? []).length, changedFiles.length);
assert.match(reviewHtml, /Why it is included/);
assert.match(reviewHtml, /public\/&lt;img src=x onerror=alert\(1\)&gt;\.txt/);
assert.match(reviewHtml, /<details class="section review-panel [^"]*"><summary>2\. Core security checkpoint/);
assert.match(reviewHtml, /<details class="section review-panel [^"]*"><summary>3\. Verification tasks/);
assert.match(reviewHtml, /class="source-approval"/);
assert.match(reviewHtml, /class="approve" type="submit" disabled/);
assert.match(reviewHtml, /\.hero a,\.hero a:visited\{color:#fff/, "Banner links must stay readable before and after visiting");
assert.match(reviewHtml, /\.hero a:focus-visible\{outline:3px solid/);
const metadata = await readPatchMetadata(sitePath);
const patchHash = sourcePatchHash(await readPendingPatch(sitePath, metadata));
let confirmationToken = "";
const form = (stage) => new URLSearchParams({ stage, reviewRunId: runId, reviewPatchHash: patchHash, confirmationToken, toolIds: tool.id, approveSourceDiff: "yes" });
const noConsent = form("prepare"); noConsent.delete("approveSourceDiff");
const refusedConsent = await fetch("http://127.0.0.1:4387/approve", { method: "POST", body: noConsent });
assert.equal(refusedConsent.status, 400);
assert.match(await refusedConsent.text(), /Explicit approval/);
for (const [field, value] of [["tasksJson", JSON.stringify(tasks.map(task => ({ ...task, verify: "true" })))], ["taskIds", tasks[0].id], ["toolsJson", JSON.stringify({ tools: [{ ...tool, description: "Changed contract" }] })]]) {
  const tampered = form("prepare"); tampered.set(field, value);
  const refused = await fetch("http://127.0.0.1:4387/approve", { method: "POST", body: tampered });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /read-only/);
}
const premature = await fetch("http://127.0.0.1:4387/approve", { method: "POST", body: form("confirm") });
assert.equal(premature.status, 400, "Direct confirmation without the prepare step is forbidden");
const response = await fetch("http://127.0.0.1:4387/approve", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form("prepare") });
const responseText = await response.text();
assert.equal(response.status, 200, responseText);
assert.match(responseText, /Review approval/, responseText);
assert.match(responseText, /confirmation-actions[^}]*margin-top:24px/, "Confirmation buttons need space below the summary");
assert.match(responseText, /class="confirmation-button confirmation-cancel" href="\/approve">Cancel<\/a>/);
assert.match(responseText, /\.confirmation-button\{[^}]*min-height:44px/);
assert.match(responseText, /\.confirmation-button:focus-visible\{outline:3px solid/);
assert.match(responseText, /name="viewport" content="width=device-width, initial-scale=1"/);
confirmationToken = responseText.match(/name="confirmationToken" value="([^"]+)"/)[1];
const heldConnection = createConnection({ host: "127.0.0.1", port: 4387 });
heldConnection.on("error", () => {});
await new Promise(resolve => heldConnection.once("connect", resolve));
heldConnection.write("GET / HTTP/1.1\r\nHost: localhost\r\nX-Unfinished:");
const lateRejection = httpRequest({ host: "127.0.0.1", port: 4387, path: "/reject", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "10" } });
lateRejection.on("error", () => {});
const lateResponse = new Promise((resolve, reject) => {
  lateRejection.once("error", reject);
  lateRejection.once("response", response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
});
lateResponse.catch(() => {});
lateRejection.write("x=");
await new Promise(resolve => setTimeout(resolve, 50));
let result;
let shutdownTimedOut = false;
try {
  const confirmation = await fetch("http://127.0.0.1:4387/approve", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form("confirm") });
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /Approved ✓/, "Closing review must not truncate the approval response");
  lateRejection.end("12345678");
  assert.equal(await lateResponse, 409, "Already-connected requests cannot mutate a finalized review during shutdown");
  assert.equal((await readPatchMetadata(sitePath)).patchStatus, "approved");
  let deadline;
  result = await Promise.race([review, new Promise(resolve => { deadline = setTimeout(() => { shutdownTimedOut = true; resolve(undefined); }, 2500); })]);
  clearTimeout(deadline);
} finally { heldConnection.destroy(); lateRejection.destroy(); }
if (!result) result = await review;
assert.equal(shutdownTimedOut, false, "An unfinished browser connection must not leave review stuck after confirmed approval");
assert.equal(result.approved, true);
const manifest = JSON.parse(await readFile(path.join(sitePath, ".webmcpify", "approved-tools.json"), "utf8"));
assert.equal(manifest.tools[0].description, tool.description);
assert.deepEqual(manifest.tasks, tasks, "Approval must preserve the server-owned generated task set");
assert.deepEqual(manifest.toolNames, [tool.name]);
assert.equal(manifest.sourceDiff.status, "approved");
assert.match(manifest.sourceDiff.patchHash, /^[a-f0-9]{64}$/);
assert.equal(JSON.parse(await readFile(path.join(sitePath, "tasks.json"), "utf8")).length, 5);
const reopened = await runReviewPrompt(sitePath, "4389", { fixture: true });
assert.equal(reopened.approved, true);
assert.equal(reopened.tasks.length, 5);

await writeFile(path.join(sitePath, ".webmcpify", "pending-diff.meta.json"), `${JSON.stringify({ version: 1, runId: "review-fixture-reject", timestamp: new Date().toISOString(), targetProject: sitePath, changedFiles, patchStatus: "awaiting-review", patchPath: path.join(sitePath, ".webmcpify", "pending-diff.patch"), generationTrajectory: generation }, null, 2)}\n`);
const rejectionReady = reviewReadiness();
const rejection = runReviewPrompt(sitePath, "4388", { fixture: true }, { onReady: rejectionReady.onReady });
await rejectionReady.wait(rejection);
const rejectResponse = await fetch("http://127.0.0.1:4388/reject", { method: "POST" });
assert.equal(rejectResponse.status, 200);
const rejected = await rejection;
assert.equal(rejected.approved, false);
assert.ok(existsSync(path.join(sitePath, ".webmcpify", "approved-tools.json")));
const abortController = new AbortController();
const cancellationReady = reviewReadiness();
const cancelled = withOperationSignal(abortController.signal, () => runReviewPrompt(sitePath, "4388", { fixture: true }, { onReady: cancellationReady.onReady }));
const cancelledAssertion = assert.rejects(cancelled, /Review was cancelled/);
await cancellationReady.wait(cancelled);
abortController.abort();
await cancelledAssertion;
await assert.rejects(fetch("http://127.0.0.1:4388"), undefined, "Cancelled review must release its localhost server");
const busyPort = createServer();
await new Promise((resolve, reject) => { busyPort.once("error", reject); busyPort.listen(4390, "127.0.0.1", resolve); });
const fallbackController = new AbortController();
try {
  const fallbackReady = reviewReadiness();
  const fallback = withOperationSignal(fallbackController.signal, () => runReviewPrompt(sitePath, "4390", { fixture: true }, { onReady: fallbackReady.onReady }));
  const fallbackAssertion = assert.rejects(fallback, /Review was cancelled/);
  await fallbackReady.wait(fallback);
  assert.equal((await fetch("http://127.0.0.1:4391/approve")).status, 200, "Occupied review port must fall back");
  fallbackController.abort();
  await fallbackAssertion;
} finally { fallbackController.abort(); await new Promise((resolve) => busyPort.close(resolve)); }
await rm(sitePath, { recursive: true, force: true });
console.log("review verification passed: read-only contracts/tasks, tamper rejection, exact-patch confirmation, cancellation, and rejection");
