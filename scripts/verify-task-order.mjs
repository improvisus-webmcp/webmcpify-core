import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractTasksFromText, loadApprovedTasks, taskFingerprint, validateTasks, validateToolScaledTasks, writeApprovedTasksAtomically } from "../dist/lib/tasks.js";
import { completeSelectionTasks, retainedSelectionTasks } from "../dist/lib/review-selection.js";
import { expectedRejectionObserved, requiredToolsObserved } from "../dist/lib/scoring.js";

const names = ["compare_coffee", "open_flight", "set_preferences"];
const error = "The tasting flight builder is already open.";
const contracts = names.map(name => ({ name, behavior: { expectedFailures: name === "open_flight" ? [{ condition: "Already open", error }] : [] } }));
const makeTask = (id, requiredTools) => ({ id, description: "Verify flight state", verify: "document.body.dataset.flight === 'open'", requiredTools, setup: "Establish flight state through the approved tools" });
// Canonical tasks saved by the previous normalizer contain unique names.
const retained = [makeTask("retained_open", names.slice(0, 2)), makeTask("retained_preferences", names)];
assert.deepEqual(validateTasks(retained), retained, "Existing canonical task definitions must not change");
assert.equal(JSON.stringify(validateTasks(retained)), JSON.stringify(retained), "Canonical saved field order must remain unchanged");
const snapshot = JSON.stringify(retained);
const proposed = { ...makeTask("already_open_rejected", [" compare_coffee ", "open_flight", "set_preferences", "open_flight"]), expectedOutcome: "rejection", expectedError: error };
const rejection = validateTasks([proposed])[0];
assert.deepEqual(rejection.requiredTools, [...names, "open_flight"]);
assert.deepEqual(validateTasks([rejection]), [rejection], "Normalization must be idempotent");
const block = "TASKS_JSON\n```json\n" + JSON.stringify([proposed]) + "\n```";
assert.deepEqual(extractTasksFromText(block), [rejection]);
const correction = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: block } });
assert.deepEqual(extractTasksFromText(correction), [rejection], "Metadata correction must retain the repeated primary call");

const collision = { ...retained[0], description: "Attempted overwrite of an existing task" };
const combined = completeSelectionTasks(retained, [collision, rejection, makeTask("comparison_boundary", [names[0]])], contracts);
assert.equal(combined.length, 4);
assert.deepEqual(combined.slice(0, 2), retained, "Generated supplements cannot overwrite retained definitions");
assert.equal(JSON.stringify(retained), snapshot, "Merging must not mutate retained tasks");
assert.equal(taskFingerprint(combined.slice(0, 2)), taskFingerprint(retained));
assert.deepEqual(validateToolScaledTasks(combined, contracts), combined, "Repeated validation must preserve mixed task identity");
assert.deepEqual(retainedSelectionTasks(combined, contracts.slice(0, 2), [contracts[2]]).map(task => task.id), ["retained_open", "comparison_boundary"]);
assert.throws(() => validateToolScaledTasks(combined.map(task => task.id === rejection.id ? { ...task, expectedError: "Unrelated error" } : task), contracts), /expectedError is not declared/);
assert.throws(() => validateToolScaledTasks(combined.map(task => task.id === rejection.id ? { ...task, requiredTools: [...task.requiredTools, "unapproved"] } : task), contracts), /unavailable/);

const evidence = calls => ({ source: "chrome-devtools-mcp", pageId: 7, discovered: true, calls, policyViolations: [] });
const calls = rejection.requiredTools.map((toolName, index) => ({ toolName, status: index === 3 ? "error" : "success", ...(index === 3 ? { error } : {}) }));
assert.equal(expectedRejectionObserved(rejection, evidence(calls)), true);
assert.equal(expectedRejectionObserved(rejection, evidence(calls.slice(1))), false, "Missing setup must fail");
assert.equal(expectedRejectionObserved(rejection, evidence([calls[0], calls[2], calls[1], calls[3]])), false, "Incorrect call order must fail");
assert.equal(expectedRejectionObserved(rejection, evidence([...calls.slice(0, 3), { toolName: "open_flight", status: "error", error: "Network error" }])), false);
assert.equal(expectedRejectionObserved(rejection, evidence([...calls, calls[1]])), false, "Successful retry after rejection must fail");
assert.equal(expectedRejectionObserved(rejection, evidence([...calls, calls[3]])), false, "Repeated rejection attempts must fail");
const positive = validateTasks([makeTask("repeat_success", [...names, "open_flight"])])[0];
assert.equal(requiredToolsObserved(positive, evidence(calls.map(call => ({ toolName: call.toolName, status: "success" })))), true);
assert.equal(requiredToolsObserved(positive, evidence(calls.slice(0, 3))), false, "One call cannot satisfy two required sequence entries");

const site = await mkdtemp(path.join(os.tmpdir(), "webmcpify-task-order-"));
const manifest = tasks => ({ version: 1, approved: true, approvalId: "fixture", draftPath: "fixture", taskSetId: taskFingerprint(tasks), tasks });
try {
  await mkdir(path.join(site, ".webmcpify"));
  // Read a pre-existing approval directly, without first rewriting it.
  const taskFile = path.join(site, ".webmcpify/tasks.json");
  const approvalFile = path.join(site, ".webmcpify/approved-tools.json");
  await writeFile(taskFile, JSON.stringify(retained));
  await writeFile(approvalFile, JSON.stringify(manifest(retained)));
  const oldTaskBytes = await readFile(taskFile, "utf8");
  const oldApprovalBytes = await readFile(approvalFile, "utf8");
  assert.deepEqual(await loadApprovedTasks(site), retained);
  assert.equal(await readFile(taskFile, "utf8"), oldTaskBytes);
  assert.equal(await readFile(approvalFile, "utf8"), oldApprovalBytes, "Loading old approvals must not rewrite fingerprints");
  await writeApprovedTasksAtomically(site, manifest(combined));
  assert.deepEqual(await loadApprovedTasks(site), combined, "Mixed retained/new approval must round-trip without dropping calls");
  const saved = JSON.parse(await readFile(approvalFile, "utf8"));
  assert.equal(saved.taskSetId, taskFingerprint(combined));
} finally {
  await rm(site, { recursive: true, force: true });
}
console.log("Task order verification passed: repeated primary calls, metadata correction, retained/new merging, rejected-tool pruning, stable old/new approvals, and ordered execution evidence");
