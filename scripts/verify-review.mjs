import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTrajectoryArtifact } from "../dist/lib/trajectories.js";
import { runReviewPrompt } from "../dist/commands/review.js";
import { taskVerificationIssues } from "../dist/lib/tasks.js";
import { withOperationSignal } from "../dist/lib/operation-context.js";
import { writeProposedTools } from "../dist/lib/tool-proposals.js";
import { readPatchMetadata, readPendingPatch, sourcePatchHash } from "../dist/lib/patches.js";

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
await writeFile(path.join(sitePath, ".webmcpify", "pending-diff.patch"), "diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export function App() { return null; }\n+export function App() { return <button>Run</button>; }\n");
await writeFile(path.join(sitePath, ".webmcpify", "pending-diff.meta.json"), `${JSON.stringify({ version: 1, runId, timestamp: new Date().toISOString(), targetProject: sitePath, changedFiles: ["src/App.tsx"], patchStatus: "awaiting-review", patchPath: path.join(sitePath, ".webmcpify", "pending-diff.patch"), generationTrajectory: generation }, null, 2)}\n`);
const tasks = Array.from({ length: 5 }, (_, index) => ({ id: `task_${index + 1}`, description: `Check result ${index + 1}`, requiredTools: ["run_action"], verify: `document.querySelector("#result-${index + 1}") !== null` }));
assert.ok(taskVerificationIssues({ id: "bad_syntax", description: "Check the result", verify: "document.querySelector(" }).some((issue) => issue.severity === "error"));
assert.ok(taskVerificationIssues({ id: "trivial", description: "Check the result", verify: "true" }).some((issue) => issue.code === "trivial"));
assert.ok(taskVerificationIssues({ id: "missing_selector", description: "Check the result", verify: 'document.querySelector("#missing") !== null' }, { discovery }).some((issue) => issue.severity === "warning"));
const review = runReviewPrompt(sitePath, "4387", { fixture: true });
await new Promise((resolve) => setTimeout(resolve, 100));
const reviewHtml = await (await fetch("http://127.0.0.1:4387/approve")).text();
assert.match(reviewHtml, /Project: review-fixture &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.ok(reviewHtml.includes(sitePath));
assert.doesNotMatch(reviewHtml, /<img src=x onerror=/);
const editedTool = { ...tool, description: "Edited reviewed action description." };
const metadata = await readPatchMetadata(sitePath);
const patchHash = sourcePatchHash(await readPendingPatch(sitePath, metadata));
let confirmationToken = "";
const form = (stage) => { const value = new URLSearchParams({ stage, reviewRunId: runId, reviewPatchHash: patchHash, confirmationToken, toolIds: tool.id, toolsJson: JSON.stringify({ tools: [editedTool] }), tasksJson: JSON.stringify(tasks), approveSourceDiff: "yes" }); for (const task of tasks) value.append("taskIds", task.id); return value; };
const premature = await fetch("http://127.0.0.1:4387/approve", { method: "POST", body: form("confirm") });
assert.equal(premature.status, 400, "Direct confirmation without the prepare step is forbidden");
const response = await fetch("http://127.0.0.1:4387/approve", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form("prepare") });
const responseText = await response.text();
assert.equal(response.status, 200, responseText);
assert.match(responseText, /Review approval/, responseText);
assert.match(responseText, /confirmation-actions[^}]*margin-top:24px/, "Confirmation buttons need space below the summary");
confirmationToken = responseText.match(/name="confirmationToken" value="([^"]+)"/)[1];
const confirmation = await fetch("http://127.0.0.1:4387/approve", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form("confirm") });
assert.equal(confirmation.status, 200);
const result = await review;
assert.equal(result.approved, true);
const manifest = JSON.parse(await readFile(path.join(sitePath, ".webmcpify", "approved-tools.json"), "utf8"));
assert.equal(manifest.tools[0].description, editedTool.description);
assert.deepEqual(manifest.toolNames, [tool.name]);
assert.equal(manifest.sourceDiff.status, "approved");
assert.match(manifest.sourceDiff.patchHash, /^[a-f0-9]{64}$/);
assert.equal(JSON.parse(await readFile(path.join(sitePath, "tasks.json"), "utf8")).length, 5);
const reopened = await runReviewPrompt(sitePath, "4389", { fixture: true });
assert.equal(reopened.approved, true);
assert.equal(reopened.tasks.length, 5);

await writeFile(path.join(sitePath, ".webmcpify", "pending-diff.meta.json"), `${JSON.stringify({ version: 1, runId: "review-fixture-reject", timestamp: new Date().toISOString(), targetProject: sitePath, changedFiles: ["src/App.tsx"], patchStatus: "awaiting-review", patchPath: path.join(sitePath, ".webmcpify", "pending-diff.patch"), generationTrajectory: generation }, null, 2)}\n`);
const rejection = runReviewPrompt(sitePath, "4388", { fixture: true });
await new Promise((resolve) => setTimeout(resolve, 100));
const rejectResponse = await fetch("http://127.0.0.1:4388/reject", { method: "POST" });
assert.equal(rejectResponse.status, 200);
const rejected = await rejection;
assert.equal(rejected.approved, false);
assert.ok(existsSync(path.join(sitePath, ".webmcpify", "approved-tools.json")));
const abortController = new AbortController();
const cancelled = withOperationSignal(abortController.signal, () => runReviewPrompt(sitePath, "4388", { fixture: true }));
const cancelledAssertion = assert.rejects(cancelled, /Review was cancelled/);
await new Promise((resolve) => setTimeout(resolve, 100));
abortController.abort();
await cancelledAssertion;
await assert.rejects(fetch("http://127.0.0.1:4388"), undefined, "Cancelled review must release its localhost server");
const busyPort = createServer();
await new Promise((resolve, reject) => { busyPort.once("error", reject); busyPort.listen(4390, "127.0.0.1", resolve); });
const fallbackController = new AbortController();
try {
  const fallback = withOperationSignal(fallbackController.signal, () => runReviewPrompt(sitePath, "4390", { fixture: true }));
  const fallbackAssertion = assert.rejects(fallback, /Review was cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await fetch("http://127.0.0.1:4391/approve")).status, 200, "Occupied review port must fall back");
  fallbackController.abort();
  await fallbackAssertion;
} finally { fallbackController.abort(); await new Promise((resolve) => busyPort.close(resolve)); }
await rm(sitePath, { recursive: true, force: true });
console.log("review verification passed: structured display/edit persistence, task approval, and rejection");
