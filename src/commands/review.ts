import express from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createTrajectoryArtifact,
  latestTrajectoryPath,
} from "../lib/trajectories.js";
import {
  extractTasksFromText,
  tasksPath,
  approvedManifestPath,
  loadApprovedTasks,
  taskFingerprint,
  writeApprovedTasksAtomically,
  type ApprovedTaskManifest,
  type Task,
  validateTaskToolBindings,
  validateToolScaledTasks,
} from "../lib/tasks.js";
import { patchExists, patchMetadataPath, readPatchMetadata, readPendingPatch, sourcePatchHash, writePatchMetadata } from "../lib/patches.js";
import { proposedToolsPath, validateProposedTools, loadDiscovery, type ProposedTool } from "../lib/tool-proposals.js";
import { taskVerificationIssues } from "../lib/tasks.js";
import { CHROME_WEBMCP_URL, WEBMCP_SPEC_URL } from "../lib/webmcp-spec-guidance.js";
import { auditToolSecurity, resolveSecurityPolicy, writeSecurityReport } from "../lib/security-audit.js";
import { currentOperationSignal } from "../lib/operation-context.js";
import { reviseToolSelection } from "../lib/review-selection.js";
import { projectDisplayName } from "../lib/project-identity.js";
import { reviewBusyPage, reviewClientScript } from "../lib/review-ui.js";
import { describeReviewFiles } from "../lib/review-files.js";
import { withCliProgress } from "../lib/cli-progress.js";

export interface ReviewOptions {
  port?: string;
  path?: string;
}

export interface ReviewResult {
  approved: boolean;
  tools: string[];
  tasks: Task[];
  approvalPath: string;
  decisionPath?: string;
  sourceDiff: { status: "approved" | "rejected"; runId?: string; timestamp: string; patchHash?: string };
  approvedTools: ProposedTool[];
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function draftText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["response", "result", "text"]) {
        if (typeof record[key] === "string") return record[key];
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4173");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid review port "${value}". Use a number from 1 to 65535.`);
  }
  return port;
}

function nextPort(port: number): number {
  return port === 65_535 ? 1 : port + 1;
}

function selectedIds(requestBody: { ids?: unknown }): string[] {
  const selected = Array.isArray(requestBody.ids)
    ? requestBody.ids
    : typeof requestBody.ids === "string"
      ? [requestBody.ids]
      : [];
  return [
    ...new Set(selected.map((value) => String(value).trim()).filter(Boolean)),
  ];
}

/** Start the approval UI and resolve only after the owner approves or rejects. */
export async function runReviewPrompt(
  sitePath: string,
  requestedPort?: string,
  trajectoryMetadata: Record<string, unknown> = {}
): Promise<ReviewResult> {
  const discovery = await loadDiscovery(sitePath);
  const projectName = htmlEscape(projectDisplayName(discovery));
  const proposalFile = proposedToolsPath(sitePath);
  if (!existsSync(proposalFile)) throw new Error(`No structured tool proposal found at ${proposalFile}. Run "webmcpify generate" first.`);
  const hasPatch = patchExists(sitePath);
  const initialMetadata = hasPatch ? await readPatchMetadata(sitePath) : undefined;
  if (!initialMetadata) throw new Error(`No valid pending source patch found at ${patchMetadataPath(sitePath)}. Run "webmcpify generate" first.`);
  let patchMetadata = initialMetadata;
  let draftPath = patchMetadata.generationTrajectory;
  if (!existsSync(draftPath)) throw new Error(`The pending patch references missing generation trajectory ${draftPath}.`);
  let draft = draftText(await readFile(draftPath, "utf8"));
  let securityPolicy = resolveSecurityPolicy(patchMetadata.securityPolicy);
  let proposedTools: ProposedTool[];
  try { proposedTools = validateProposedTools(JSON.parse(await readFile(proposalFile, "utf8")), discovery); }
  catch (error) { throw new Error(`Could not load structured tool proposals: ${error instanceof Error ? error.message : String(error)}`); }
  let initialSecurity = auditToolSecurity(proposedTools, discovery, sitePath, securityPolicy);
  await writeSecurityReport(sitePath, initialSecurity);
  // A repair patch changes source only; it must reuse the already-approved
  // task definitions instead of asking the repair agent to redraft or alter
  // the evaluation criteria.
  // Durable Temporal repairs must preserve the task set captured when the
  // workflow started. Their generation pass may emit exploratory TASKS_JSON,
  // but it must never replace the approved criteria or change task IDs while
  // later workflow steps are still referring to them.
  let proposedTasks = patchMetadata.repair || trajectoryMetadata.durable === true
    ? await loadApprovedTasks(sitePath)
    : extractTasksFromText(draft) ?? [];
  if (patchMetadata.repair || trajectoryMetadata.durable === true) validateTaskToolBindings(proposedTasks, proposedTools);
  else proposedTasks = validateToolScaledTasks(proposedTasks, proposedTools);
  const projectTasksPath = tasksPath(sitePath);
  const approvalPath = path.join(
    sitePath,
    ".webmcpify",
    "approved-tools.json"
  );
  let patch = await readPendingPatch(sitePath, patchMetadata);
  let patchHash = sourcePatchHash(patch);
  let approvalId = patchMetadata.runId;
  let proposedToolIds = new Set(proposedTools.map((tool) => tool.id));
  if (existsSync(approvalPath)) {
    try {
      const existing = JSON.parse(await readFile(approvalPath, "utf8")) as Partial<ApprovedTaskManifest> & { approvedAt?: string; sourceDiff?: { runId?: string; patchHash?: string } };
      if (existing.approved === true && existing.approvalId === approvalId && existing.sourceDiff?.patchHash === patchHash && existing.taskSetId && existing.tasks) {
        const tasks = await loadApprovedTasks(sitePath);
        const tools = validateProposedTools(existing.tools, discovery);
        const sourceDiff = { status: "approved" as const, runId: approvalId, patchHash, timestamp: String(existing.approvedAt ?? new Date().toISOString()) };
        return { approved: true, tools: tools.map((tool) => tool.name), approvedTools: tools, tasks, approvalPath, sourceDiff };
      }
    } catch { /* stale or incomplete approval is never reused */ }
  }
  let port = parsePort(requestedPort);
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  let revising = false;
  let processingApproval = false;
  let closing = false;
  let revisionJob: { state: "idle" | "revising" | "ready" | "error"; phase?: string; message?: string; startedAt?: number } = { state: "idle" };
  let activeRevision: Promise<void> | undefined;
  let pendingConfirmation: { token: string; input: string } | undefined;
  let retrySelection: Set<string> | undefined;

  const reloadDraft = async () => {
    const metadata = await readPatchMetadata(sitePath);
    const tools = validateProposedTools(JSON.parse(await readFile(proposalFile, "utf8")), discovery);
    const text = draftText(await readFile(metadata.generationTrajectory, "utf8"));
    const tasks = extractTasksFromText(text);
    if (!tasks) throw new Error("The revised draft has no valid task set.");
    validateToolScaledTasks(tasks, tools);
    const nextPatch = await readPendingPatch(sitePath, metadata);
    const policy = resolveSecurityPolicy(metadata.securityPolicy);
    const security = auditToolSecurity(tools, discovery, sitePath, policy);
    patchMetadata = metadata; proposedTools = tools; proposedTasks = tasks;
    draftPath = metadata.generationTrajectory; draft = text; patch = nextPatch;
    securityPolicy = policy; initialSecurity = security;
    patchHash = sourcePatchHash(nextPatch); approvalId = metadata.runId;
    proposedToolIds = new Set(tools.map(tool => tool.id)); pendingConfirmation = undefined;
  };
  app.get("/review-status", (_request, response) => {
    response.set("Cache-Control", "no-store").json({ ...revisionJob, state: revising ? "revising" : processingApproval || closing ? "busy" : revisionJob.state, runId: approvalId, patchHash });
  });

  const renderLocked = (response: express.Response, message = "Approved ✓") => {
    response.type("html").send(`<!doctype html><html lang="en"><body><h1>${message}</h1><p>The approval for this draft is persisted and locked. You can close this window.</p><button disabled>Approved — locked</button></body></html>`);
  };

  const approvalIsPersisted = async (): Promise<boolean> => {
    if (!existsSync(approvalPath)) return false;
    try {
      const existing = JSON.parse(await readFile(approvalPath, "utf8")) as Partial<ApprovedTaskManifest> & { tools?: unknown[]; sourceDiff?: { patchHash?: string } };
      if (existing.approved !== true || existing.approvalId !== approvalId || existing.sourceDiff?.patchHash !== patchHash || !existing.tasks || !existing.tools) return false;
      await loadApprovedTasks(sitePath);
      validateProposedTools(existing.tools, discovery);
      return true;
    } catch {
      return false;
    }
  };

  app.get(["/", "/approve"], async (_request, response) => {
    response.set("Cache-Control", "no-store");
    if (revising || processingApproval) { response.type("html").send(reviewBusyPage(projectDisplayName(discovery), revisionJob.phase ?? "Processing review…")); return; }
    const persisted = await approvalIsPersisted();
    // A POST may have started while the persisted manifest was being read.
    if (revising || processingApproval) { response.type("html").send(reviewBusyPage(projectDisplayName(discovery), revisionJob.phase ?? "Processing review…")); return; }
    if (persisted) {
      renderLocked(response);
      return;
    }
    const checkboxes = proposedTools.length
      ? proposedTools
          .map(
            (tool) =>
              `<label class="item"><input type="checkbox" name="toolIds" value="${htmlEscape(
                tool.id
              )}"${!retrySelection || retrySelection.has(tool.id) ? " checked" : ""}> <strong>${htmlEscape(tool.name)}</strong> — ${htmlEscape(tool.title)} — ${htmlEscape(tool.description)}<br><small>Access: this tool only · read-only: ${String(tool.annotations.readOnlyHint)} · untrusted output: ${String(tool.annotations.untrustedContentHint)} · consequential: ${String(tool.annotations.consequentialHint)}</small></label>`
          )
          .join("\n")
      : `<p>No structured tool proposals were found.</p>`;
    const toolDetails = proposedTools.map((tool) => `<details><summary>${htmlEscape(tool.name)}</summary><pre>${htmlEscape(JSON.stringify(tool, null, 2))}</pre></details>`).join("\n");
    const securityRows = initialSecurity.findings.length
      ? initialSecurity.findings.map((item) => `<li><strong>${htmlEscape(item.severity.toUpperCase())}</strong> · <code>${htmlEscape(item.toolId)}</code> — ${htmlEscape(item.message)}<br><small>${htmlEscape(item.recommendation)}</small></li>`).join("")
      : "<li>No static access-control findings.</li>";

    const taskRows = proposedTasks.length
      ? proposedTasks
          .map(
            (task) =>
              `<article class="item"><strong>${htmlEscape(task.id)}</strong>: ${htmlEscape(
                task.description
              )}<br><small>Expected outcome: ${htmlEscape(task.expectedOutcome ?? "success")}${task.expectedError ? ` · expected error: ${htmlEscape(task.expectedError)}` : ""}</small><br><code>${htmlEscape(task.verify)}</code>${taskVerificationIssues(task, { discovery, toolNames: proposedTools.map((tool) => tool.name) }).map((issue) => `<br><em>${htmlEscape(issue.severity.toUpperCase())}: ${htmlEscape(issue.message)}</em>`).join("")}</article>`
          )
          .join("\n")
      : `<p>No valid task proposal was found. Regenerate before approving.</p>`;

    const panel = (title: string, content: string, open = false, classes = "") => `<details class="section review-panel ${classes}"${open ? " open" : ""}><summary>${title}</summary><div class="panel-content">${content}</div></details>`;
    const files = describeReviewFiles(patch, proposedTools);
    const fileRows = files.map(file => `<tr data-review-file="${htmlEscape(file.file)}"><td><code>${htmlEscape(file.file)}</code></td><td>${file.change}</td><td>${htmlEscape(file.reason)}</td></tr>`).join("\n");
    const fileSection = panel(`4. Files in this patch <span class="count">${files.length} total</span>`, `<p class="hint">Every added, modified, deleted, renamed, or copied path is shown—not just the first ten. Reasons summarize file roles and declared tool-placement rationale; the exact diff is the authority.</p><div class="file-table"><table><thead><tr><th scope="col">File</th><th scope="col">Change</th><th scope="col">Why it is included</th></tr></thead><tbody>${fileRows}</tbody></table></div>`, true);
    const sourceSection = panel("5. Exact source patch", `<p><strong>${htmlEscape(patchMetadata.patchStatus)}</strong> — inspect every change before checking source approval below.</p><pre>${htmlEscape(patch)}</pre>`, false, "source");

    response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${projectName} · Approve WebMCP changes</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.shell{max-width:1120px;margin:0 auto;padding:32px 20px 120px}.hero{background:linear-gradient(135deg,#172554,#2563eb);color:#fff;border-radius:20px;padding:30px 34px;box-shadow:0 12px 35px #1725542e}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.78}.hero h1{font-size:32px;margin:8px 0}.hero p{max-width:760px;margin:0;color:#dbeafe;line-height:1.55}.notice{display:flex;gap:14px;align-items:flex-start;margin:22px 0;padding:18px 20px;border:1px solid #f0c36a;border-radius:14px;background:#fff9e8;color:#694d05}.notice strong{display:block;color:#3d2b00;margin-bottom:3px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.card,.section{background:#fff;border:1px solid #dce3ef;border-radius:16px;padding:22px;box-shadow:0 4px 14px #1725540b}.section{margin-top:18px}.section h2{margin:0 0 14px;font-size:20px}.section>p{color:#536176}.count{display:inline-flex;align-items:center;gap:7px;background:#eaf1ff;color:#1746a2;border-radius:999px;padding:5px 10px;font-size:13px;font-weight:750}.item{display:block;padding:14px 0;border-top:1px solid #edf0f5;line-height:1.45}.item:first-of-type{border-top:0}.item input{width:18px;height:18px;vertical-align:-4px;margin-right:8px;accent-color:#2563eb}.item strong{color:#111827}.item code,.hint{color:#536176;font-size:12px}.item code{display:block;margin:8px 0 0 28px;padding:8px;background:#f6f8fb;border-radius:8px;overflow:auto}.warning{display:block;margin:8px 0 0 28px;color:#9a5b00;font-size:12px}.source{border-color:#f0c36a;background:#fffdf7}.source pre,pre{white-space:pre-wrap;background:#f6f8fb;border:1px solid #e5eaf2;padding:14px;border-radius:10px;max-height:40vh;overflow:auto;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}textarea{width:100%;min-height:150px;border:1px solid #cbd5e1;border-radius:10px;padding:12px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}details{margin-top:14px}summary{cursor:pointer;font-weight:700;color:#1746a2}.draft{margin-top:18px}.actions{position:fixed;bottom:0;left:0;right:0;background:#fffffff2;border-top:1px solid #dce3ef;backdrop-filter:blur(10px);padding:14px 20px;z-index:2}.actions-inner{max-width:1120px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:14px}.actions small{color:#536176}.actions button{border:0;border-radius:10px;padding:13px 22px;font-weight:800;font-size:15px;cursor:pointer}.approve{background:#16a34a;color:#fff;box-shadow:0 5px 15px #16a34a40}.reject{background:#fff;color:#b42318;border:1px solid #efb6b0!important}.actions button:hover{filter:brightness(.96)}@media(max-width:760px){.grid{grid-template-columns:1fr}.hero{padding:24px}.hero h1{font-size:26px}.actions-inner{align-items:stretch;flex-direction:column}.actions small{display:none}}
.grid{align-items:start}.grid>.card{margin-top:0}.review-panel>summary{font-size:20px;color:#172033}.panel-content{margin-top:18px}.card>summary{font-size:18px}.file-table{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:12px;border-bottom:1px solid #e5eaf2;vertical-align:top}td code{overflow-wrap:anywhere}.source-approval{margin-top:22px;padding:24px;border:2px solid #df9c23;border-radius:16px;background:#fff5d9}.source-approval label{display:flex;align-items:flex-start;gap:16px;cursor:pointer}.source-approval input{width:30px;height:30px;flex:none;accent-color:#16a34a;margin:0}.source-approval strong{display:block;font-size:22px;line-height:1.3}.source-approval small{display:block;margin-top:10px;font-size:15px;color:#694d05}.approve:disabled{background:#64748b;opacity:.65;cursor:not-allowed;box-shadow:none}.actions button:disabled:hover{filter:none}.actions [role=status]{max-width:420px;font-size:14px;color:#694d05}
</style></head><body><main class="shell">
<header class="hero"><div class="eyebrow">WebMCPify · Human approval required</div><h1>Review WebMCP draft</h1><p><strong>Project: ${projectName}</strong><br>Repository folder: ${htmlEscape(sitePath)}</p><p>Inspect the proposed tools, verification tasks, and source patch. Nothing is applied to the target project until you explicitly approve this exact patch.</p><p class="hint">Reference: <a href="${WEBMCP_SPEC_URL}" target="_blank" rel="noreferrer">WebMCP specification</a> · <a href="${CHROME_WEBMCP_URL}" target="_blank" rel="noreferrer">Chrome WebMCP guide</a></p></header>
${revisionJob.message ? `<div class="notice" role="alert">${htmlEscape(revisionJob.message)}</div>` : ""}<div class="notice"><div>⚠️</div><div><strong>Action required</strong>Select only the WebMCP tools you want this project to make available to the approved browser-agent workflow. Review each tool's title, description, schema, and risk annotations, then approve the exact source patch separately.</div></div>
<div class="grid"><details class="card"><summary>What will be approved?</summary><div class="panel-content"><p><span class="count">${proposedTools.length} tools</span> <span class="count">${proposedTasks.length} tests</span> <span class="count">${files.length} files</span></p><p class="hint">Approval creates a local manifest and task set. It does not deploy or apply source changes; the separate apply step does that.</p></div></details><details class="card"><summary>Before approving</summary><div class="panel-content"><p class="hint">Confirm that every tool maps to a real user action, every task has a meaningful verification expression, and the source diff contains only expected changes.</p><p class="hint">Only tool selection is editable. Generated contracts and verification tasks are read-only.</p></div></details></div>
<form id="review-form" method="post" action="/approve"><input type="hidden" name="stage" value="prepare"><input type="hidden" name="reviewRunId" value="${htmlEscape(approvalId)}"><input type="hidden" name="reviewPatchHash" value="${patchHash}">
${panel(`1. Proposed tools <span class="count">${proposedTools.length} proposed</span>`, `<p class="hint">Uncheck unwanted tools. Continuing with a subset removes rejected registrations and updates corresponding tests/docs in a disposable workspace, then returns a revised patch for fresh review. It does not approve the original patch.</p><p id="selection-status" role="status" aria-live="polite"></p>${checkboxes}<details><summary>Inspect generated tool definitions (read-only)</summary>${toolDetails}</details>`, true)}
${panel(`2. Core security checkpoint <span class="count">${securityPolicy}</span> <span class="count">${initialSecurity.status}</span>`, `<p class="hint">${securityPolicy === "ignore" ? "Automated security gating is disabled for this draft. Inspect the exact source patch carefully before approval." : securityPolicy === "balance" ? "High-impact access-control gaps and invalid cross-origin exposure block approval; ordinary reversible UI actions do not." : "Static declarations are not proof. Match execution scope and applicable controls to the actual handler; browser-only UI state needs no invented backend. Blocking findings cannot be approved."}</p><ul>${securityRows}</ul>`, initialSecurity.status === "block")}
${panel(`3. Verification tasks <span class="count">${proposedTasks.length} proposed</span>`, `<p class="hint">These generated tasks are read-only. Changing tool selection automatically revises corresponding tasks; you cannot remove checks or edit their pass criteria.</p>${taskRows}`)}
${fileSection}${sourceSection}
${panel("6. Raw generation draft", `<pre>${htmlEscape(draft)}</pre>`)}
<section class="source-approval" aria-label="Required source patch approval"><label for="approve-source-patch"><input id="approve-source-patch" type="checkbox" name="approveSourceDiff" value="yes" aria-required="true" aria-describedby="source-approval-help"${retrySelection ? " disabled" : ""}><span><strong>I approve this exact source patch</strong><small id="source-approval-help">Required before “Approve reviewed draft” is enabled. Disabled while tools are deselected: prepare and review the revised draft first. Check only after reviewing every file and the exact diff above.</small></span></label></section>
<div class="actions"><div class="actions-inner"><span id="approval-status" role="status" aria-live="polite">Check “I approve this exact source patch” to enable approval.</span><div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap"><button class="reject" type="submit" formaction="/reject">Reject draft</button><button class="approve" type="submit" disabled>✓ Approve reviewed draft</button></div></div></div></form></main><script>
${reviewClientScript(approvalId)}
</script></body></html>`);
  });

  let server: ReturnType<typeof app.listen> | undefined;
  const signal = currentOperationSignal();
  signal?.throwIfAborted();
  let abortReview: (() => void) | undefined;
  type ReviewDecision = ReviewResult;
  const decision = new Promise<ReviewDecision>((resolve, reject) => {
    abortReview = () => {
      server?.closeAllConnections();
      server?.close();
      reject(new Error("Review was cancelled; no new approval was created."));
    };
    signal?.addEventListener("abort", abortReview, { once: true });
    const finish = (result: ReviewDecision, response: express.Response) => {
      closing = true;
      const closingServer = server;
      if (!closingServer) { resolve(result); return; }
      void withCliProgress("review", "Closing review connections", () => new Promise<void>(closed => {
        let forceClose: NodeJS.Timeout | undefined;
        let finished = false;
        // Flush the approval/rejection response before cutting off unfinished
        // requests. Idle-only closure cannot drain a partially sent request.
        const flushComplete = () => {
          if (finished || forceClose) return;
          forceClose = setTimeout(() => closingServer.closeAllConnections(), 1000);
          forceClose.unref();
        };
        closingServer.close(() => {
          finished = true;
          if (forceClose) clearTimeout(forceClose);
          response.off("finish", flushComplete); response.off("close", flushComplete);
          closed();
        });
        closingServer.closeIdleConnections();
        if (response.writableFinished || response.destroyed) flushComplete();
        else { response.once("finish", flushComplete); response.once("close", flushComplete); }
      })).then(() => resolve(result), reject);
    };

    const selectionInput = (request: express.Request) => {
      if (["tasksJson", "taskIds", "toolsJson"].some(field => Object.hasOwn(request.body, field))) throw new Error("Generated contracts and tasks are read-only. Reload review and select only tools.");
      const ids = selectedIds({ ids: request.body.toolIds });
      if (ids.some(id => !proposedToolIds.has(id))) throw new Error("Approval can only select tools from this generated draft.");
      const tools = proposedTools.filter(tool => ids.includes(tool.id));
      if (!tools.length || ids.length !== tools.length) throw new Error("Select at least one tool; use Reject draft to reject all tools.");
      const security = auditToolSecurity(tools, discovery, sitePath, securityPolicy);
      if (security.status === "block") throw new Error(`Approval blocked by ${security.summary.block} Core security finding(s). Fix the source and generate again.`);
      return tools;
    };

    const approvalInput = (request: express.Request, tools: ProposedTool[]) => {
      validateTaskToolBindings(proposedTasks, tools);
      if (!hasPatch || request.body.approveSourceDiff !== "yes") throw new Error("Explicit approval of the pending source diff is required.");
      return { tools, tasks: proposedTasks };
    };

    const confirmationPage = (response: express.Response, input: { tools: ProposedTool[]; tasks: Task[] }) => {
      pendingConfirmation = { token: randomUUID(), input: JSON.stringify(input) };
      const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`;
      response.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Confirm WebMCP approval</title><style>body{font:16px system-ui,sans-serif;max-width:800px;margin:3rem auto;padding:0 1rem}.summary{background:#fff8d8;border:1px solid #e7cf62;padding:1rem;border-radius:10px}.confirmation-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}button{padding:.7rem 1rem}</style></head><body><h1>Review approval for ${projectName}</h1><div class="summary"><p>You are about to approve:</p><ul><li>${input.tools.length} tools</li><li>${input.tasks.length} verification tasks</li><li>${patchMetadata.changedFiles.length} source files: ${htmlEscape(patchMetadata.changedFiles.join(", "))}</li><li>Source changes: awaiting application after approval</li></ul></div><form id="confirmation-form" class="confirmation-actions" method="post" action="/approve">${hidden("stage", "confirm")}${hidden("reviewRunId", approvalId)}${hidden("reviewPatchHash", patchHash)}${hidden("confirmationToken", pendingConfirmation.token)}${input.tools.map((tool) => hidden("toolIds", tool.id)).join("")}${hidden("approveSourceDiff", "yes")}<button type="submit">Confirm Approval</button><a href="/approve">Cancel</a></form><script>${reviewClientScript(approvalId)}</script></body></html>`);
    };

    app.post("/approve", async (request, response) => {
      if (processingApproval || revising || closing) { response.status(409).type("html").send(reviewBusyPage(projectDisplayName(discovery), revisionJob.phase ?? "Processing review…")); return; }
      processingApproval = true;
      try {
        const existing = existsSync(approvalPath) ? JSON.parse(await readFile(approvalPath, "utf8")) as Partial<ApprovedTaskManifest> & { sourceDiff?: { runId?: string; patchHash?: string } } : undefined;
        if (existing?.approved === true && existing.approvalId === approvalId && existing.sourceDiff?.patchHash === patchHash) { renderLocked(response); return; }
        if (request.body.reviewRunId !== approvalId || request.body.reviewPatchHash !== patchHash) throw new Error("This form belongs to a different draft. Reload and review the current source patch.");
        const selected = selectionInput(request);
        if (selected.length !== proposedTools.length) {
          if (request.body.stage === "confirm") throw new Error("Changed tool selection requires preparing a revised draft, not confirming the old one.");
          if (trajectoryMetadata.durable === true || patchMetadata.repair) throw new Error("Repair/durable review cannot change its fixed tool or task set. Reject this repair and generate a new draft instead.");
          if (sourcePatchHash(await readPendingPatch(sitePath, patchMetadata)) !== patchHash) throw new Error("Pending patch changed while its review was open; review the new patch.");
          revising = true;
          retrySelection = new Set(selected.map(tool => tool.id));
          const rejected = proposedTools.filter((tool) => !selected.some((approved) => approved.id === tool.id));
          console.log(`[review] drafting a revised patch for ${selected.length} selected tool(s); ${rejected.length} rejected tool(s) will be omitted`);
          pendingConfirmation = undefined;
          revisionJob = { state: "revising", phase: "Preparing selected tools", startedAt: Date.now() };
          response.status(202).type("html").send(reviewBusyPage(projectDisplayName(discovery), revisionJob.phase!));
          activeRevision = (async () => {
            try {
              await reviseToolSelection(sitePath, discovery, patchMetadata, selected, rejected, phase => { revisionJob.phase = phase; });
              try { await reloadDraft(); }
              catch (error) {
                const diagnostic = await createTrajectoryArtifact("review-refresh-failure", { error: error instanceof Error ? error.message : String(error) }, { sitePath, status: "failed" });
                throw new Error(`The revised draft could not be loaded. Restart review; no approval was created. Private diagnostics: ${diagnostic}`);
              }
              revisionJob = { state: "ready" };
              retrySelection = undefined;
              console.log("[review] revised draft ready; review the new patch before approval");
            } catch (error) {
              const message = error instanceof Error ? error.message : "Revision failed. Restart review."; // revision errors are already redacted
              revisionJob = { state: "error", message };
              console.error(`[review] ${message}`);
            } finally { revising = false; }
          })();
          return;
        }
        const input = approvalInput(request, selected);
        if (request.body.stage !== "confirm") { confirmationPage(response, input); return; }
        if (!pendingConfirmation || request.body.confirmationToken !== pendingConfirmation.token || JSON.stringify(input) !== pendingConfirmation.input) throw new Error("Prepare and review this exact approval before confirming; changed selections require a new confirmation.");
        if (sourcePatchHash(await readPendingPatch(sitePath, patchMetadata)) !== patchHash) throw new Error("Pending patch changed while its review was open; review the new patch.");
        const approvalManifest = { version: 1 as const, approved: true as const, approvalId, draftPath, taskSetId: taskFingerprint(input.tasks), tasks: input.tasks, tools: input.tools, toolNames: input.tools.map((tool) => tool.name), tasksPath: projectTasksPath, proposedToolsPath: proposalFile, sourceDiff: { status: "approved" as const, runId: approvalId, patchHash, timestamp: new Date().toISOString() } };
        const sourceDiff = {
          status: "approved" as const,
          runId: patchMetadata.runId,
          patchHash,
          timestamp: new Date().toISOString(),
        };
        const decisionPath = await withCliProgress("review", "Saving confirmed approval", async () => {
          await writeApprovedTasksAtomically(sitePath, approvalManifest);
          await writePatchMetadata(sitePath, { ...patchMetadata, patchStatus: "approved" });
          return createTrajectoryArtifact(
            "review-decision",
            {
              version: 1,
              approved: true,
              tools: input.tools,
              toolNames: input.tools.map((tool) => tool.name),
              tasks: input.tasks,
              approvalPath,
              tasksPath: projectTasksPath,
              proposedToolsPath: proposalFile,
              sourceDiff,
              draftPath,
              reviewedAt: new Date().toISOString(),
            },
            {
              sitePath,
              draftPath,
              approvalPath,
              port,
              ...trajectoryMetadata,
            }
          );
        });
        console.log(`[review] approval confirmed: ${input.tools.length} tool(s), ${input.tasks.length} task(s), ${patchMetadata.changedFiles.length} source file(s)`);
        console.log("[review] approval saved; closing review and returning control to the CLI workflow");

        response.type("html").send(`<!doctype html><html lang="en"><body>
<h1>Approved ✓</h1><p>${input.tools.length} tool(s) and ${input.tasks.length} verification task(s) have been persisted for <code>${htmlEscape(
          sitePath
        )}</code>.</p><p>You can close this window.</p></body></html>`);
        finish({ approved: true, tools: input.tools.map((tool) => tool.name), approvedTools: input.tools, tasks: input.tasks, approvalPath, decisionPath, sourceDiff }, response);
      } catch (error) {
        console.error(`[review] approval failed: ${error instanceof Error ? error.message : String(error)}`);
        response
          .status(400)
          .type("html")
          .send(`<!doctype html><html lang="en"><body><h1>Review could not continue</h1><p role="alert">${htmlEscape(error instanceof Error ? error.message : String(error))}</p><a href="/">Return to review</a></body></html>`);
      } finally { processingApproval = false; }
    });

    app.post("/reject", async (_request, response) => {
      if (processingApproval || revising || closing) { response.status(409).type("html").send(reviewBusyPage(projectDisplayName(discovery), revisionJob.phase ?? "Processing review…")); return; }
      processingApproval = true;
      try {
        if (patchMetadata) {
          await writePatchMetadata(sitePath, {
            ...patchMetadata,
            patchStatus: "rejected",
            error: "Rejected during human review.",
          });
        }
        const decisionPath = await createTrajectoryArtifact(
          "review-decision",
          {
            version: 1,
            approved: false,
            tools: [],
            tasks: [],
            approvalPath,
            draftPath,
            proposedToolsPath: proposalFile,
            sourceDiff: { status: "rejected", timestamp: new Date().toISOString() },
            reviewedAt: new Date().toISOString(),
          },
          {
            sitePath,
            draftPath,
            approvalPath,
            port,
            ...trajectoryMetadata,
          }
        );
        console.log("[review] draft rejected; no source changes were approved");
        response.type("html").send(`<!doctype html><html lang="en"><body>
<h1>Draft rejected</h1><p>No approval manifest was changed.</p></body></html>`);
        finish({ approved: false, tools: [], approvedTools: [], tasks: [], approvalPath, decisionPath, sourceDiff: { status: "rejected", timestamp: new Date().toISOString() } }, response);
      } catch (error) {
        console.error(`[review] rejection failed: ${error instanceof Error ? error.message : String(error)}`);
        response
          .status(500)
          .type("text")
          .send(error instanceof Error ? error.message : String(error));
      } finally { processingApproval = false; }
    });

    let portAttempts = 0;
    const startServer = (candidate: number): void => {
      if (signal?.aborted) { abortReview?.(); return; }
      if (++portAttempts > 20) { reject(new Error("No review port available after 20 attempts. Choose an available port with --port.")); return; }
      const listener = app.listen(candidate, "127.0.0.1", () => {
        server = listener;
        if (signal?.aborted) { abortReview?.(); return; }
        port = candidate;
        console.log("[review] ============================================================");
        console.log("[review] ACTION REQUIRED: open the approval page and click the green approval button");
        console.log(`[review] APPROVAL PAGE: http://127.0.0.1:${port}`);
        console.log(`[review] approved manifest will be saved to ${approvalPath}`);
        console.log("[review] Review the tools, tests, and source diff, then click “Approve reviewed draft”.");
        console.log("[review] ============================================================");
      });
      server = listener;
      listener.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          listener.close(() => startServer(nextPort(candidate)));
          return;
        }
        reject(error);
      });
    };
    startServer(port);
  });

  let result: ReviewDecision;
  try { result = await decision; }
  finally { if (abortReview) signal?.removeEventListener("abort", abortReview); if (activeRevision) await activeRevision; }
  return result;
}

export async function runReview(opts: ReviewOptions): Promise<void> {
  const sitePath = path.resolve(opts.path ?? process.cwd());
  const result = await runReviewPrompt(sitePath, opts.port);
  console.log(
    `[review] ${result.approved ? "approved" : "rejected"} ${
      result.tools.length
    } tool(s), ${result.tasks.length} task(s)`
  );
  if (result.decisionPath) {
    console.log(`[review] decision saved to ${result.decisionPath}`);
  }
  if (result.approved) {
    console.log("[review] next: run \"webmcpify apply --path <target>\" to apply the approved patch, then run the browser test");
  } else {
    console.log("[review] next: revise the draft and run \"webmcpify generate --path <target>\" again");
  }
}
