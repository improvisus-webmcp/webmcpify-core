import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { runAgent } from "../lib/agent.js";
import { resolveProvider } from "../lib/ai-provider.js";
import {
  WEBMCP_SPEC_GUIDANCE,
  TASK_AUTHORING_PROMPT,
  TOOL_PLACEMENT_GUIDANCE,
  TOOL_PROPOSAL_PROMPT,
} from "../lib/prompts.js";
import { createTrajectoryPath } from "../lib/trajectories.js";
import { createPendingPatch } from "../lib/patches.js";
import { runGenerationPreflight } from "../lib/preflight.js";
import { readFile } from "node:fs/promises";
import { discoveryPath, runDiscovery } from "../lib/discovery.js";
import { extractAndValidateProposedTools, writeProposedTools } from "../lib/tool-proposals.js";
import { extractTasksFromText, validateTaskToolBindings } from "../lib/tasks.js";
import { auditToolSecurity, resolveSecurityPolicy, writeSecurityReport } from "../lib/security-audit.js";
import {
  createAgentWorkspace,
  initializeAgentWorkspace,
  readAgentWorkspaceDiff,
  removeAgentWorkspace,
} from "../lib/agent-workspace.js";

export const GENERATE_ONLY_PROMPT = `
Focused generation: read ./.webmcpify/discovery.json first and draft WebMCP
tool registrations only for the discovered actions —
declarative (HTML form attributes) for simple single-input actions, imperative
(document.modelContext) for actions needing custom logic or state. Report the
relevant discovery findings briefly, then make the source edits in the
workspace. Do not output a unified diff, a patch, or instructions to apply a
diff: Core captures the actual workspace diff itself. Do not deploy or run
browser verification — WebMCPify will compile-check this disposable workspace
before the draft reaches human review.

You are working in a disposable workspace, not the target checkout. Make the
proposed source edits in this workspace so WebMCPify can capture the exact
working-tree diff. A text-only proposal is not a completed task. Before ending,
verify that one or more source files are actually modified in this workspace.
Never edit .webmcpify artifacts and never claim a diff for files you did not
actually inspect.

Before importing any function, value, or type from an existing module, inspect
that module and verify the symbol is actually exported. Never invent a public
type such as ShopState. If a type is internal, derive the type locally from
the public API or keep the generated handler independent of that type. Run the
workspace typecheck after editing and fix generated import/export errors before
reporting the proposal.

The current working directory is the only project you may access. Do not use
absolute paths, inspect parent directories, or access any checkout outside it.

Every imperative integration must be wired into code that runs once on app load
or the relevant route, and must safely access document.modelContext. Use one
stable AbortController per registration lifecycle; abort it on cleanup rather
than calling unregisterTool. Every
declarative integration must add tool-name to the real rendered form. Do not
leave a standalone unregistered module. These runtime requirements are checked
before approval.

${TOOL_PLACEMENT_GUIDANCE}

${WEBMCP_SPEC_GUIDANCE}

${TOOL_PROPOSAL_PROMPT}

${TASK_AUTHORING_PROMPT}
`.trim();

export const GENERATION_METHODS = [
  "declarative",
  "imperative",
  "auto",
] as const;

export type GenerationMethod = (typeof GENERATION_METHODS)[number];

function resolveMethod(method?: string): GenerationMethod {
  const selected = method ?? "auto";
  if ((GENERATION_METHODS as readonly string[]).includes(selected)) {
    return selected as GenerationMethod;
  }

  throw new Error(
    `Unknown generation method "${selected}". Choose one of: ${GENERATION_METHODS.join(
      ", "
    )}.`
  );
}

function methodInstruction(method: GenerationMethod): string {
  switch (method) {
    case "declarative":
      return `For this run, use the declarative approach for every drafted
tool: prefer HTML form attributes and existing form submit behavior.`;
    case "imperative":
      return `For this run, use the imperative approach for every drafted
tool: register through document.modelContext with explicit schemas, title,
annotations, and handlers. Return plain serializable values from execute;
never wrap results in an MCP content envelope.`;
    case "auto":
      return "";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function repairGeneratedWorkspace(
  opts: GenerateOptions,
  sitePath: string,
  workspace: string,
  provider: ReturnType<typeof resolveProvider>,
  preflightError: unknown,
): Promise<void> {
  // Keep the repair prompt focused on the actionable tail of compiler output.
  // The full output remains available in the trajectory/error artifact.
  const details = errorText(preflightError).slice(-4_000);
  const repairTrajectory = createTrajectoryPath("generate-fix", undefined, sitePath);
  console.warn("[generate] preflight failed; requesting one focused fix in the disposable workspace...");
  await runAgent({
    provider,
    prompt: `The generated source in this disposable workspace failed WebMCPify's
pre-approval compile check. Fix only the reported compiler errors in the
workspace. Do not redo discovery, change the approved tool names, schemas, or
task definitions, and do not refactor unrelated code.

Compiler output:
${details}

Pay special attention to optional WebMCP context values captured by nested
callbacks: after checking the optional value, assign it to a new explicitly
typed immutable local and use that local inside every callback. Do not capture
the optional variable after its guard. Also verify every imported symbol is
exported by its source module; do not change unrelated target application code
just to provide an export for generated code. Make the smallest source edit
needed, then stop; WebMCPify will run the compile check again before human
review.`,
    cwd: workspace,
    allowedTools: "Read,Edit",
    saveTo: repairTrajectory,
    trajectoryMetadata: {
      role: "generate-fix",
      sitePath,
      sourceTrajectory: opts.trajectoryMetadata?.sourceTrajectory,
      preflightError: details,
      method: opts.method,
    },
  });
}

async function retryWorkspaceEdit(
  opts: GenerateOptions,
  sitePath: string,
  workspace: string,
  provider: ReturnType<typeof resolveProvider>,
  sourceTrajectory: string,
): Promise<void> {
  const retryTrajectory = createTrajectoryPath("generate-edit", undefined, sitePath);
  console.warn("[generate] provider returned a text-only proposal; requesting one edit-only retry in the disposable workspace...");
  await runAgent({
    provider,
    prompt: `Your previous response described source changes but did not modify
the disposable workspace. This retry is complete only when source files in the
current workspace have been edited.

Do not inspect task logs, manage background tasks, output a patch, explain a
diff, or tell someone else to apply changes. Use your edit tool now to make the
smallest valid WebMCP source changes required by ./.webmcpify/discovery.json.
Do not edit .webmcpify artifacts. Do not change unrelated code. Do not finish
until the workspace has a real source diff. Reply only after the edits exist;
WebMCPify will capture and validate them.`,
    cwd: workspace,
    allowedTools: "Read,Edit",
    saveTo: retryTrajectory,
    trajectoryMetadata: {
      role: "generate-edit",
      sitePath,
      sourceTrajectory,
      method: opts.method,
    },
  });
}

export interface GenerateOptions {
  path?: string;
  provider?: string;
  method?: string;
  context?: string;
  trajectoryMetadata?: Record<string, unknown>;
  preserveApprovalState?: boolean;
  security?: string;
}

async function invalidateDraftState(sitePath: string): Promise<void> {
  const stateDirectory = path.join(sitePath, ".webmcpify");
  const staleDirectory = path.join(stateDirectory, "stale");
  await mkdir(staleDirectory, { recursive: true });
  // tasks.json belongs to the target project's approved evaluation state. Do
  // not move or rewrite it during generation; a new task set replaces it only
  // when the human approval transaction completes.
  const staleAt = Date.now();
  for (const file of [
    path.join(stateDirectory, "approved-tools.json"),
    path.join(stateDirectory, "proposed-tools.json"),
    path.join(stateDirectory, "security-report.json"),
    path.join(stateDirectory, "pending-diff.patch"),
    path.join(stateDirectory, "pending-diff.meta.json"),
  ]) {
    if (!existsSync(file)) continue;
    await rename(file, path.join(staleDirectory, `${staleAt}-${path.basename(file)}`));
  }
}

export async function runGenerate(opts: GenerateOptions) {
  const provider = resolveProvider(opts.provider);
  const method = resolveMethod(opts.method);
  const securityPolicy = resolveSecurityPolicy(opts.security, "strict");
  const sitePath = path.resolve(opts.path ?? process.cwd());

  if (!existsSync(sitePath)) {
    throw new Error(`Site path does not exist: ${sitePath}`);
  }

  if (!opts.preserveApprovalState) await invalidateDraftState(sitePath);

  const discovery = await runDiscovery(sitePath);

  const saveTo = createTrajectoryPath("generate", undefined, sitePath);
  const strategy = methodInstruction(method);
  const securityInstruction = securityPolicy === "strict"
    ? `Use Core's strict security posture. Every state-changing tool must use real backend or server-action authorization. Consequential actions must also have real user and agent binding, quotas, and replay protection.`
    : securityPolicy === "balance"
      ? `Use Core's balanced security posture. Require real backend authorization, user and agent binding, quotas, and replay protection only for genuinely high-impact actions such as checkout, payment, order submission, financial transfers, destructive account changes, or external publication/communication. Ordinary reversible UI state such as filtering, adding or removing cart items, and login/logout must reuse the site's existing behavior and must not gain invented backend services, identity systems, quotas, idempotency keys, or artificial string limits solely to satisfy the audit. Keep every security declaration honest.`
      : `Core security gating is ignored for this run. Do not invent or add backend services, identity systems, quotas, idempotency keys, or artificial string limits solely for Core metadata. Keep any security declaration honest and preserve the site's existing behavior; the exact patch still requires human approval.`;
  const failureContext = opts.context
    ? `A previous independent test reported this failure. Use it to focus the
drafted repair, but still inspect the code rather than assuming the diagnosis:
${opts.context}`
    : "";
  // Do not expose the real checkout path to an unrestricted provider process.
  // The provider receives a local copy in its disposable workspace below.
  const agentDiscovery = { ...discovery, targetProject: "." };
  const prompt = [GENERATE_ONLY_PROMPT, `The structured discovery is available at ./.webmcpify/discovery.json. Read that file as the source of truth; do not invent actions or repeat its full contents in your response.`, strategy, securityInstruction, failureContext]
    .filter(Boolean)
    .join("\n\n");

  console.log(
    `[generate] drafting WebMCP tools for ${sitePath} via ${provider} (${method})...`
  );

  const agentWorkspace = await createAgentWorkspace(sitePath);
  await initializeAgentWorkspace(agentWorkspace);
  await mkdir(path.join(agentWorkspace, ".webmcpify"), { recursive: true });
  await writeFile(
    path.join(agentWorkspace, ".webmcpify", "discovery.json"),
    `${JSON.stringify({ ...discovery, targetProject: "." }, null, 2)}\n`,
    "utf8",
  );
  let workspaceDiff = "";
  try {
    await runAgent({
      provider,
      prompt,
      cwd: agentWorkspace,
      // Providers may ignore permission hints. The disposable workspace is
      // the actual safety boundary keeping the target checkout untouched.
      allowedTools: "Read,Edit",
      saveTo,
      trajectoryMetadata: {
        role: "generate",
        sitePath,
        method,
        securityPolicy,
        context: opts.context,
        discoveryPath: discoveryPath(sitePath),
        ...opts.trajectoryMetadata,
      },
    });
    workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
    if (!workspaceDiff.trim()) {
      await retryWorkspaceEdit(opts, sitePath, agentWorkspace, provider, saveTo);
      workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
    }
    if (!workspaceDiff.trim()) {
      throw new Error(
        discovery.existingWebMCP.length > 0
          ? "Existing WebMCP registrations were found, but the generation provider did not create a source edit after its focused retry. The target was left unchanged."
          : "The generation provider did not modify files in its disposable workspace after an edit-only retry. Provider-reported diffs are informational only; no source patch can be created safely."
      );
    }
    try {
      await runGenerationPreflight(sitePath, agentWorkspace);
    } catch (error) {
      await repairGeneratedWorkspace(opts, sitePath, agentWorkspace, provider, error);
      workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
      await runGenerationPreflight(sitePath, agentWorkspace);
    }
    await assertGeneratedWebMcpWiring(agentWorkspace, discovery, workspaceDiff);
  } finally {
    await removeAgentWorkspace(agentWorkspace);
  }

  try {
    const rawDraft = await readFile(saveTo, "utf8");
    const tools = extractAndValidateProposedTools(rawDraft, discovery);
    const proposedTasks = extractTasksFromText(rawDraft);
    if (!proposedTasks) {
      throw new Error("The generation output did not contain 5-6 valid verification tasks. Every task must declare requiredTools from the generated proposal.");
    }
    validateTaskToolBindings(proposedTasks, tools.map((tool) => tool.name));
    const proposalFile = await writeProposedTools(sitePath, tools, discoveryPath(sitePath), saveTo);
    const security = auditToolSecurity(tools, discovery, sitePath, securityPolicy);
    const securityFile = await writeSecurityReport(sitePath, security);
    if (security.status === "block") {
      throw new Error(`Security review blocked this proposal (${security.summary.block} blocking finding(s)). Inspect ${securityFile}; no pending patch was created.`);
    }
    const patch = await createPendingPatch(
      sitePath,
      workspaceDiff,
      saveTo,
      { securityPolicy },
    );
    console.log(`[generate] draft saved to ${saveTo}`);
    console.log(`[generate] proposed tools: ${proposalFile}`);
    console.log(`[generate] validated ${tools.length} tool proposal(s)`);
    console.log(`[generate] security (${securityPolicy}): ${security.status} (${security.summary.review} review finding(s)); ${securityFile}`);
    console.log(`[generate] generated source changes: ${patch.changedFiles.join(", ")}`);
    console.log(`[generate] patch: ${patch.patchPath}`);
    console.log("[generate] status: awaiting review");
  } catch (error) {
    console.error(`[generate] ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function assertGeneratedWebMcpWiring(
  workspace: string,
  discovery: Awaited<ReturnType<typeof runDiscovery>>,
  diff: string,
): Promise<void> {
  const source = (await Promise.all(discovery.sourceFiles.map(async (file) => {
    try {
      return await readFile(path.join(workspace, file), "utf8");
    } catch {
      return "";
    }
  }))).join("\n");
  // Include the actual diff because generation may create a new integration
  // file that was not present in the pre-generation discovery file list.
  const generatedSource = `${source}\n${diff}`;
  const hasImperativeRuntime = /document\s*\.\s*modelContext|registerTool\s*\(/.test(generatedSource);
  const hasDeclarativeRuntime = /tool-name\s*=|toolname\s*=/.test(generatedSource);
  if (!hasImperativeRuntime && !hasDeclarativeRuntime) {
    throw new Error(
      "Generated source has no current WebMCP runtime wiring. Add document.modelContext registration or tool-name on the real form before approval.",
    );
  }
}
