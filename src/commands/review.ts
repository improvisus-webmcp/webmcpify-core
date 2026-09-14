import express from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createTrajectoryArtifact,
  latestTrajectoryPath,
} from "../lib/trajectories.js";
import {
  extractTasksFromText,
  parseTasksJson,
  tasksPath,
  approvedManifestPath,
  loadApprovedTasks,
  taskFingerprint,
  writeApprovedTasksAtomically,
  type ApprovedTaskManifest,
  type Task,
} from "../lib/tasks.js";
import { patchExists, patchMetadataPath, readPatchMetadata, writePatchMetadata } from "../lib/patches.js";
import { proposedToolsPath, validateProposedTools, loadDiscovery, type ProposedTool } from "../lib/tool-proposals.js";
import { taskVerificationIssues } from "../lib/tasks.js";
import { CHROME_WEBMCP_URL, WEBMCP_SPEC_URL } from "../lib/webmcp-spec-guidance.js";
import { auditToolSecurity, writeSecurityReport } from "../lib/security-audit.js";

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
  sourceDiff: { status: "approved" | "rejected"; runId?: string; timestamp: string };
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
  const proposalFile = proposedToolsPath(sitePath);
  if (!existsSync(proposalFile)) throw new Error(`No structured tool proposal found at ${proposalFile}. Run "webmcpify generate" first.`);
  const hasPatch = patchExists(sitePath);
  const patchMetadata = hasPatch ? await readPatchMetadata(sitePath) : undefined;
  if (!patchMetadata) throw new Error(`No valid pending source patch found at ${patchMetadataPath(sitePath)}. Run "webmcpify generate" first.`);
  const draftPath = patchMetadata.generationTrajectory;
  if (!existsSync(draftPath)) throw new Error(`The pending patch references missing generation trajectory ${draftPath}.`);
  const draft = draftText(await readFile(draftPath, "utf8"));
  let proposedTools: ProposedTool[];
  try { proposedTools = validateProposedTools(JSON.parse(await readFile(proposalFile, "utf8")), discovery); }
  catch (error) { throw new Error(`Could not load structured tool proposals: ${error instanceof Error ? error.message : String(error)}`); }
  const initialSecurity = auditToolSecurity(proposedTools, discovery, sitePath);
  await writeSecurityReport(sitePath, initialSecurity);
  // A repair patch changes source only; it must reuse the already-approved
  // task definitions instead of asking the repair agent to redraft or alter
  // the evaluation criteria.
  // Durable Temporal repairs must preserve the task set captured when the
  // workflow started. Their generation pass may emit exploratory TASKS_JSON,
  // but it must never replace the approved criteria or change task IDs while
  // later workflow steps are still referring to them.
  const proposedTasks = patchMetadata.repair || trajectoryMetadata.durable === true
    ? await loadApprovedTasks(sitePath)
    : extractTasksFromText(draft) ?? [];
  if (proposedTasks.length < 5 || proposedTasks.length > 6) throw new Error(`Generated draft must contain 5-6 valid tasks; received ${proposedTasks.length}. Fix the generation output before review.`);
  const projectTasksPath = tasksPath(sitePath);
  const approvalPath = path.join(
    sitePath,
    ".webmcpify",
    "approved-tools.json"
  );
  const patch = await readFile(patchMetadata.patchPath, "utf8");
  const approvalId = patchMetadata.runId;
  const proposedToolIds = new Set(proposedTools.map((tool) => tool.id));
  if (existsSync(approvalPath)) {
    try {
      const existing = JSON.parse(await readFile(approvalPath, "utf8")) as Partial<ApprovedTaskManifest> & { approvedAt?: string; sourceDiff?: { runId?: string } };
      if (existing.approved === true && existing.approvalId === approvalId && existing.taskSetId && existing.tasks) {
        const tasks = await loadApprovedTasks(sitePath);
        const tools = validateProposedTools(existing.tools, discovery);
        const sourceDiff = { status: "approved" as const, runId: approvalId, timestamp: String(existing.approvedAt ?? new Date().toISOString()) };
        return { approved: true, tools: tools.map((tool) => tool.name), approvedTools: tools, tasks, approvalPath, sourceDiff };
      }
    } catch { /* stale or incomplete approval is never reused */ }
  }
  let port = parsePort(requestedPort);
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const renderLocked = (response: express.Response, message = "Approved ✓") => {
    response.type("html").send(`<!doctype html><html lang="en"><body><h1>${message}</h1><p>The approval for this draft is persisted and locked. You can close this window.</p><button disabled>Approved — locked</button></body></html>`);
  };

  const approvalIsPersisted = async (): Promise<boolean> => {
    if (!existsSync(approvalPath)) return false;
    try {
      const existing = JSON.parse(await readFile(approvalPath, "utf8")) as Partial<ApprovedTaskManifest> & { tools?: unknown[] };
      if (existing.approved !== true || existing.approvalId !== approvalId || !existing.tasks || !existing.tools) return false;
      await loadApprovedTasks(sitePath);
      validateProposedTools(existing.tools, discovery);
      return true;
    } catch {
      return false;
    }
  };

  app.get(["/", "/approve"], async (_request, response) => {
    if (await approvalIsPersisted()) {
      renderLocked(response);
      return;
    }
    const checkboxes = proposedTools.length
      ? proposedTools
          .map(
            (tool) =>
              `<label class="item"><input type="checkbox" name="toolIds" value="${htmlEscape(
                tool.id
              )}" checked> <strong>${htmlEscape(tool.name)}</strong> — ${htmlEscape(tool.title)} — ${htmlEscape(tool.description)}<br><small>Access: this tool only · read-only: ${String(tool.annotations.readOnlyHint)} · untrusted output: ${String(tool.annotations.untrustedContentHint)} · consequential: ${String(tool.annotations.consequentialHint)}</small></label>`
          )
          .join("\n")
      : `<p>No structured tool proposals were found.</p>`;
    const toolJson = htmlEscape(JSON.stringify(proposedTools, null, 2));
    const toolDetails = proposedTools.map((tool) => `<details><summary>${htmlEscape(tool.name)}</summary><pre>${htmlEscape(JSON.stringify(tool, null, 2))}</pre></details>`).join("\n");
    const securityRows = initialSecurity.findings.length
      ? initialSecurity.findings.map((item) => `<li><strong>${htmlEscape(item.severity.toUpperCase())}</strong> · <code>${htmlEscape(item.toolId)}</code> — ${htmlEscape(item.message)}<br><small>${htmlEscape(item.recommendation)}</small></li>`).join("")
      : "<li>No static access-control findings.</li>";

    const taskRows = proposedTasks.length
      ? proposedTasks
          .map(
            (task) =>
              `<label class="item"><input type="checkbox" name="taskIds" value="${htmlEscape(
                task.id
              )}" checked> <strong>${htmlEscape(task.id)}</strong>: ${htmlEscape(
                task.description
              )}<br><code>${htmlEscape(task.verify)}</code>${taskVerificationIssues(task, { discovery, toolNames: proposedTools.map((tool) => tool.name) }).map((issue) => `<br><em>${htmlEscape(issue.severity.toUpperCase())}: ${htmlEscape(issue.message)}</em>`).join("")}</label>`
          )
          .join("\n")
      : `<p>No valid 5-6 task proposal was found. Edit the JSON below before approving.</p>`;
    const taskJson = htmlEscape(JSON.stringify(proposedTasks, null, 2));

    const sourceSection = hasPatch
      ? `<div class="section"><h2>Source changes</h2><p><strong>${htmlEscape(
          patchMetadata.patchStatus
        )}</strong> — ${htmlEscape(patchMetadata.changedFiles.join(", "))}</p><pre>${htmlEscape(
          patch
        )}</pre><label><input type="checkbox" name="approveSourceDiff" value="yes"> I approve this exact source patch</label></div>`
      : `<div class="section"><h2>Source changes</h2><p>No valid pending source patch exists. Generation must produce one before approval.</p></div>`;

    response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Approve WebMCP changes</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.shell{max-width:1120px;margin:0 auto;padding:32px 20px 120px}.hero{background:linear-gradient(135deg,#172554,#2563eb);color:#fff;border-radius:20px;padding:30px 34px;box-shadow:0 12px 35px #1725542e}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.78}.hero h1{font-size:32px;margin:8px 0}.hero p{max-width:760px;margin:0;color:#dbeafe;line-height:1.55}.notice{display:flex;gap:14px;align-items:flex-start;margin:22px 0;padding:18px 20px;border:1px solid #f0c36a;border-radius:14px;background:#fff9e8;color:#694d05}.notice strong{display:block;color:#3d2b00;margin-bottom:3px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.card,.section{background:#fff;border:1px solid #dce3ef;border-radius:16px;padding:22px;box-shadow:0 4px 14px #1725540b}.section{margin-top:18px}.section h2{margin:0 0 14px;font-size:20px}.section>p{color:#536176}.count{display:inline-flex;align-items:center;gap:7px;background:#eaf1ff;color:#1746a2;border-radius:999px;padding:5px 10px;font-size:13px;font-weight:750}.item{display:block;padding:14px 0;border-top:1px solid #edf0f5;line-height:1.45}.item:first-of-type{border-top:0}.item input{width:18px;height:18px;vertical-align:-4px;margin-right:8px;accent-color:#2563eb}.item strong{color:#111827}.item code,.hint{color:#536176;font-size:12px}.item code{display:block;margin:8px 0 0 28px;padding:8px;background:#f6f8fb;border-radius:8px;overflow:auto}.warning{display:block;margin:8px 0 0 28px;color:#9a5b00;font-size:12px}.source{border-color:#f0c36a;background:#fffdf7}.source pre,pre{white-space:pre-wrap;background:#f6f8fb;border:1px solid #e5eaf2;padding:14px;border-radius:10px;max-height:40vh;overflow:auto;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}textarea{width:100%;min-height:150px;border:1px solid #cbd5e1;border-radius:10px;padding:12px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}details{margin-top:14px}summary{cursor:pointer;font-weight:700;color:#1746a2}.draft{margin-top:18px}.actions{position:fixed;bottom:0;left:0;right:0;background:#fffffff2;border-top:1px solid #dce3ef;backdrop-filter:blur(10px);padding:14px 20px;z-index:2}.actions-inner{max-width:1120px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:14px}.actions small{color:#536176}.actions button{border:0;border-radius:10px;padding:13px 22px;font-weight:800;font-size:15px;cursor:pointer}.approve{background:#16a34a;color:#fff;box-shadow:0 5px 15px #16a34a40}.reject{background:#fff;color:#b42318;border:1px solid #efb6b0!important}.actions button:hover{filter:brightness(.96)}@media(max-width:760px){.grid{grid-template-columns:1fr}.hero{padding:24px}.hero h1{font-size:26px}.actions-inner{align-items:stretch;flex-direction:column}.actions small{display:none}}
</style></head><body><main class="shell">
<header class="hero"><div class="eyebrow">WebMCPify · Human approval required</div><h1>Review WebMCP draft</h1><p>Inspect the proposed tools, verification tasks, and source patch. Nothing is applied to the target project until you explicitly approve this exact patch.</p><p class="hint">Reference: <a href="${WEBMCP_SPEC_URL}" target="_blank" rel="noreferrer">WebMCP specification</a> · <a href="${CHROME_WEBMCP_URL}" target="_blank" rel="noreferrer">Chrome WebMCP guide</a></p></header>
<div class="notice"><div>⚠️</div><div><strong>Action required</strong>Select only the WebMCP tools you want this project to make available to the approved browser-agent workflow. Review each tool's title, description, schema, and risk annotations, then approve the exact source patch separately.</div></div>
<div class="grid"><section class="card"><h2>What will be approved?</h2><p><span class="count">${proposedTools.length} tools</span> <span class="count">${proposedTasks.length} tests</span> <span class="count">${patchMetadata.changedFiles.length} files</span></p><p class="hint">Approval creates a local manifest and task set. It does not deploy or apply source changes; the separate apply step does that.</p></section><section class="card"><h2>Before approving</h2><p class="hint">Confirm that every tool maps to a real user action, every task has a meaningful verification expression, and the source diff contains only expected changes.</p><p class="hint">You may edit the structured JSON, but keep each selected tool/task ID unchanged.</p></section></div>
<form method="post" action="/approve"><section class="section"><h2>1. Approved tools <span class="count">${proposedTools.length} proposed</span></h2><p class="hint">Each checkbox is an explicit per-tool permission for this approved evaluation and manifest. Uncheck tools the agent should not use.</p>${checkboxes}<details><summary>Inspect or edit structured tool definitions</summary>${toolDetails}<p class="hint">Keep each approved tool's <code>id</code> matched to its checkbox.</p><textarea name="toolsJson" aria-label="Tools JSON">${toolJson}</textarea></details></section>
<section class="section"><h2>2. Core security checkpoint <span class="count">${initialSecurity.status}</span></h2><p class="hint">Static declarations are not proof. Match every access-control claim to the exact backend code in the source patch. Blocking findings cannot be approved.</p><ul>${securityRows}</ul></section>
<section class="section"><h2>3. Verification tasks <span class="count">${proposedTasks.length} proposed</span></h2><p class="hint">These are the actions the browser agent will perform and the checks used to score them.</p>${taskRows}<details><summary>Edit task definitions</summary><p class="hint">Every task must have an observable <code>verify</code> expression. Keep task IDs unchanged.</p><textarea name="tasksJson" aria-label="Tasks JSON">${taskJson}</textarea></details></section>${sourceSection.replace('<div class="section">', '<section class="section source">').replace('</div>', '</section>')}
<div class="draft"><details><summary>Show raw generation draft</summary><pre>${htmlEscape(draft)}</pre></details></div>
<div class="actions"><div class="actions-inner"><small>Review complete? Your click is required to continue.</small><div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap"><button class="reject" type="submit" formaction="/reject">Reject draft</button><button class="approve" type="submit" name="stage" value="prepare">✓ Approve reviewed draft</button></div></div></div></form></main></body></html>`);
  });

  let server: ReturnType<typeof app.listen> | undefined;
  const decision = new Promise<ReviewResult>((resolve, reject) => {
    const finish = (result: ReviewResult) => {
      if (server) {
        server.close(() => resolve(result));
      } else {
        resolve(result);
      }
    };

    const approvalInput = (request: express.Request) => {
      const selectedToolIds = selectedIds({ ids: request.body.toolIds });
      const editedTools = validateProposedTools(JSON.parse(typeof request.body.toolsJson === "string" ? request.body.toolsJson : "{}"), discovery);
      if (editedTools.length === 0 || selectedToolIds.length !== editedTools.length || editedTools.some((tool) => !selectedToolIds.includes(tool.id))) throw new Error("Every approved tool must have a matching selected checkbox; approve at least one tool.");
      if (selectedToolIds.some((id) => !proposedToolIds.has(id)) || editedTools.some((tool) => !proposedToolIds.has(tool.id))) throw new Error("Approval can only select tools from this generated draft.");
      const security = auditToolSecurity(editedTools, discovery, sitePath);
      if (security.status === "block") throw new Error(`Approval blocked by ${security.summary.block} Core security finding(s). Fix the tool contract and exact source patch, then generate again.`);
      const editedTasks = parseTasksJson(typeof request.body.tasksJson === "string" ? request.body.tasksJson : "[]");
      const selectedTaskIds = selectedIds({ ids: request.body.taskIds });
      const proposedTaskIds = new Set(proposedTasks.map((task) => task.id));
      if (editedTasks.length < 5 || editedTasks.length > 6 || selectedTaskIds.length !== editedTasks.length || editedTasks.some((task) => !selectedTaskIds.includes(task.id) || !proposedTaskIds.has(task.id))) throw new Error("Approved tasks must be 5-6 valid tasks selected from this generated draft; keep task IDs unchanged.");
      if (!hasPatch || request.body.approveSourceDiff !== "yes") throw new Error("Explicit approval of the pending source diff is required.");
      return { tools: editedTools, tasks: editedTasks };
    };

    const confirmationPage = (response: express.Response, input: { tools: ProposedTool[]; tasks: Task[] }) => {
      const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`;
      response.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Confirm WebMCP approval</title><style>body{font:16px system-ui,sans-serif;max-width:800px;margin:3rem auto;padding:0 1rem}.summary{background:#fff8d8;border:1px solid #e7cf62;padding:1rem}button{padding:.7rem 1rem;margin-right:.5rem}</style></head><body><h1>Review approval</h1><div class="summary"><p>You are about to approve:</p><ul><li>${input.tools.length} tools</li><li>${input.tasks.length} verification tasks</li><li>${patchMetadata.changedFiles.length} source files: ${htmlEscape(patchMetadata.changedFiles.join(", "))}</li><li>Source changes: awaiting application after approval</li></ul></div><form method="post" action="/approve">${hidden("stage", "confirm")}${hidden("toolsJson", JSON.stringify({ tools: input.tools }))}${hidden("tasksJson", JSON.stringify(input.tasks))}${input.tools.map((tool) => hidden("toolIds", tool.id)).join("")}${input.tasks.map((task) => hidden("taskIds", task.id)).join("")}${hidden("approveSourceDiff", "yes")}<button type="submit">Confirm Approval</button><a href="/approve"><button type="button">Cancel</button></a></form></body></html>`);
    };

    app.post("/approve", async (request, response) => {
      try {
        const existing = existsSync(approvalPath) ? JSON.parse(await readFile(approvalPath, "utf8")) as Partial<ApprovedTaskManifest> & { sourceDiff?: { runId?: string } } : undefined;
        if (existing?.approved === true && existing.approvalId === approvalId) { renderLocked(response); return; }
        const input = approvalInput(request);
        if (request.body.stage !== "confirm") { confirmationPage(response, input); return; }
        const approvalManifest = { version: 1 as const, approved: true as const, approvalId, draftPath, taskSetId: taskFingerprint(input.tasks), tasks: input.tasks, tools: input.tools, toolNames: input.tools.map((tool) => tool.name), tasksPath: projectTasksPath, proposedToolsPath: proposalFile, sourceDiff: { status: "approved" as const, runId: approvalId, timestamp: new Date().toISOString() } };
        await writeApprovedTasksAtomically(sitePath, approvalManifest);
        const sourceDiff = {
          status: "approved" as const,
          runId: patchMetadata.runId,
          timestamp: new Date().toISOString(),
        };
        await writePatchMetadata(sitePath, {
          ...patchMetadata,
          patchStatus: "approved",
        });
        console.log(`[review] approval confirmed: ${input.tools.length} tool(s), ${input.tasks.length} task(s), ${patchMetadata.changedFiles.length} source file(s)`);
        const decisionPath = await createTrajectoryArtifact(
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

        response.type("html").send(`<!doctype html><html lang="en"><body>
<h1>Approved ✓</h1><p>${input.tools.length} tool(s) and ${input.tasks.length} verification task(s) have been persisted for <code>${htmlEscape(
          sitePath
        )}</code>.</p><p>You can close this window.</p></body></html>`);
        finish({ approved: true, tools: input.tools.map((tool) => tool.name), approvedTools: input.tools, tasks: input.tasks, approvalPath, decisionPath, sourceDiff });
      } catch (error) {
        console.error(`[review] approval failed: ${error instanceof Error ? error.message : String(error)}`);
        response
          .status(400)
          .type("text")
          .send(error instanceof Error ? error.message : String(error));
      }
    });

    app.post("/reject", async (_request, response) => {
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
        finish({ approved: false, tools: [], approvedTools: [], tasks: [], approvalPath, decisionPath, sourceDiff: { status: "rejected", timestamp: new Date().toISOString() } });
      } catch (error) {
        console.error(`[review] rejection failed: ${error instanceof Error ? error.message : String(error)}`);
        response
          .status(500)
          .type("text")
          .send(error instanceof Error ? error.message : String(error));
      }
    });

    const startServer = (candidate: number): void => {
      const listener = app.listen(candidate, "127.0.0.1", () => {
        server = listener;
        port = candidate;
        console.log("[review] ============================================================");
        console.log("[review] ACTION REQUIRED: open the approval page and click the green approval button");
        console.log(`[review] APPROVAL PAGE: http://127.0.0.1:${port}`);
        console.log(`[review] approved manifest will be saved to ${approvalPath}`);
        console.log("[review] Review the tools, tests, and source diff, then click “Approve reviewed draft”.");
        console.log("[review] ============================================================");
      });
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

  return decision;
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
