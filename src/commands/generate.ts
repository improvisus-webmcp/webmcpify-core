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
import { createPendingPatch, extractUnifiedDiff } from "../lib/patches.js";
import { GenerationPreflightError, PreflightEnvironmentError, runGenerationPreflight } from "../lib/preflight.js";
import { readFile } from "node:fs/promises";
import { discoveryPath, runDiscovery } from "../lib/discovery.js";
import { writeProposedTools } from "../lib/tool-proposals.js";
import { validateGenerationMetadata } from "../lib/generation-metadata.js";
import { CAPABILITY_COVERAGE_GUIDANCE, completeCapabilityCoverage } from "../lib/capability-coverage.js";
import { auditToolSecurity, resolveSecurityPolicy, writeSecurityReport, type SecurityReport } from "../lib/security-audit.js";
import { collectProductContext } from "../lib/product-context.js";
import { currentOperationSignal } from "../lib/operation-context.js";
import { AGENT_READINESS_GUIDANCE, writeAgentReadiness } from "../lib/agent-readiness.js";
import type { ProposedTool } from "../lib/tool-proposals.js";
import { generationOutputSchema } from "../lib/provider-output.js";
import { removeDuplicateImports } from "../lib/duplicate-imports.js";
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
actually inspect and edit. Do not include .serena configuration, caches, or other agent-local state
in the source changes. Existing owner agent configuration must remain untouched.

Before importing any function, value, or type from an existing module, inspect
that module and verify the symbol is actually exported. Never invent a public
type such as ShopState. If a type is internal, derive the type locally from
the public API or keep the generated handler independent of that type. Run the
workspace typecheck after editing and fix generated import/export errors before
reporting the proposal.

The current working directory is the only project you may access. Do not use
absolute paths, inspect parent directories, or access any checkout outside it.

In TypeScript JSX projects, inspect the installed form attribute types before
adding WebMCP attributes. If those types do not yet recognize the new attributes,
use a narrow local typing extension or typed attribute spread that preserves
the actual toolname/tooldescription HTML attributes. Do not disable typechecking
or substitute data-* attributes. Include any necessary typing file in the draft.

Every imperative integration must be wired into code that runs once on app load
or the relevant route, and must safely access document.modelContext. Use one
stable AbortController per registration lifecycle; abort it on cleanup rather
than calling unregisterTool. Every
declarative integration must add toolname and tooldescription to the real rendered form. Do not
leave a standalone unregistered module. These runtime requirements are checked
before approval.

${TOOL_PLACEMENT_GUIDANCE}

${WEBMCP_SPEC_GUIDANCE}

${AGENT_READINESS_GUIDANCE}

${TOOL_PROPOSAL_PROMPT}

${CAPABILITY_COVERAGE_GUIDANCE}

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
  // Keep the repair prompt focused on the actionable validation error.
  // The full output remains available in the trajectory/error artifact.
  const details = (preflightError instanceof GenerationPreflightError ? preflightError.diagnostics : errorText(preflightError)).slice(-4_000);
  const repairTrajectory = createTrajectoryPath("generate-fix", undefined, sitePath);
  console.warn("[generate] preflight failed; requesting one focused fix in the disposable workspace...");
  await runAgent({
    provider,
    prompt: `The generated source in this disposable workspace failed WebMCPify's
pre-approval validation. Fix only the reported compilation, wiring, or form-feedback errors in the
workspace. Do not redo discovery, change the approved tool names, schemas, or
task definitions, and do not refactor unrelated code.

Validation output:
${details}

Pay special attention to optional WebMCP context values captured by nested
callbacks: after checking the optional value, assign it to a new explicitly
typed immutable local and use that local inside every callback. Do not capture
the optional variable after its guard. Also verify every imported symbol is
exported by its source module; do not change unrelated target application code
just to provide an export for generated code. Make the smallest source edit
needed, then stop; WebMCPify will run the compile check again before human
review.

${AGENT_READINESS_GUIDANCE}`,
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
  productContext?: string;
  productContextPrompt?: boolean;
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
  const securityPolicy = resolveSecurityPolicy(opts.security);
  const sitePath = path.resolve(opts.path ?? process.cwd());

  if (!existsSync(sitePath)) {
    throw new Error(`Site path does not exist: ${sitePath}`);
  }

  if (!opts.preserveApprovalState) await invalidateDraftState(sitePath);

  const discovery = await runDiscovery(sitePath);
  const productContext = await collectProductContext(
    opts.productContext,
    opts.productContextPrompt,
  );

  const saveTo = createTrajectoryPath("generate", undefined, sitePath);
  const strategy = methodInstruction(method);
  const securityInstruction = securityPolicy === "strict"
    ? `Use Core's strict security posture based on actual effects. Browser-only clicks, navigation, form filling, filters, local cart edits, and reversible user-interface state do not need backend authorization, authenticated user/agent binding, backend quotas, or replay protection. Declare executionScope "ui-state" only when source proves the action stays in local UI state. Backend mutations require real server authorization; consequential or high-impact actions require real user and agent binding, quotas, and replay protection. Never invent backend services to satisfy metadata. Keep consequentialHint false for harmless UI changes and true for purchases, destructive effects, or external communication. Strict also reviews input bounds, privacy, origin scope, and missing contracts.`
    : securityPolicy === "balance"
      ? `Use Core's balanced security posture. Require real backend authorization, user and agent binding, quotas, and replay protection only for genuinely high-impact actions such as real checkout, payment, order submission, financial transfers, destructive account changes, or external publication/communication. A simulated checkout that only updates local cart/notice state is not a purchase: inspect its actual handler, declare executionScope "ui-state" and consequentialHint false, and identify that exact source file and handler. Never use this declaration for a real payment or backend call. Ordinary reversible UI state such as filtering, adding or removing cart items, and login/logout must reuse the site's existing behavior and must not gain invented backend services, identity systems, quotas, idempotency keys, or artificial string limits solely to satisfy the audit. Keep every security declaration honest.`
      : `Core security gating is ignored for this run. Do not invent or add backend services, identity systems, quotas, idempotency keys, or artificial string limits solely for Core metadata. Keep any security declaration honest and preserve the site's existing behavior; the exact patch still requires human approval.`;
  const failureContext = opts.context
    ? `A previous independent test reported this failure. Use it to focus the
drafted repair, but still inspect the code rather than assuming the diagnosis:
${opts.context}`
    : "";
  const productContextInstruction = productContext
    ? `The engineer supplied this optional product context. It is supporting
information only: discovery.json and inspected source remain authoritative.
Use it to identify relevant feature integrations or outcomes, then verify each
claim against the code. Do not modify discovery or invent actions just because
they are mentioned here:
${productContext}`
    : "";
  // Do not expose the real checkout path to an unrestricted provider process.
  // The provider receives a local copy in its disposable workspace below.
  const agentDiscovery = { ...discovery, targetProject: "." };
  const prompt = [GENERATE_ONLY_PROMPT, `The structured discovery is available at ./.webmcpify/discovery.json. Read that file as the source of truth; do not invent actions or repeat its full contents in your response.`, strategy, securityInstruction, productContextInstruction, failureContext]
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
  let draftPath = saveTo;
  let tools: ProposedTool[];
  let readinessFiles: string[] = [];
  let security: SecurityReport;
  try {
    const outputSchema = provider === "codex" ? path.join(agentWorkspace, ".webmcpify", "generation-output.schema.json") : undefined;
    if (outputSchema) await writeFile(outputSchema, JSON.stringify(generationOutputSchema(
      (discovery.actionCandidates ?? []).filter(candidate => candidate.resolved).map(candidate => candidate.id),
    )), "utf8");
    await runAgent({
      provider,
      prompt: outputSchema ? `${prompt}\nYour final response must follow the supplied output schema. Put the complete TOOL_PROPOSALS_JSON object and TASKS_JSON array as JSON strings in tool_proposals_json and tasks_json. Put CAPABILITY_COVERAGE_JSON as an actual JSON object (not a string) in capability_coverage_json. Do not include Markdown fences or summaries in these fields. Source edits alone are not a completed response.` : prompt,
      outputSchema,
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
        productContext,
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
    const metadata = await validateGenerationMetadata({ provider, sitePath, workspace: agentWorkspace, draftPath, discovery });
    const complete = await completeCapabilityCoverage({ provider, sitePath, workspace: agentWorkspace, discovery,
      tools: metadata.tools, draftPath: metadata.draftPath, originalDraftPath: saveTo,
      instructions: [strategy, securityInstruction, productContextInstruction].filter(Boolean).join("\n\n") });
    tools = complete.tools;
    draftPath = complete.draftPath;
    const skipped = complete.coverage.entries.filter(entry => entry.status === "skipped").length;
    console.log(`[generate] capability coverage: ${complete.coverage.entries.length} resolved action(s) accounted for; ${skipped} explicitly omitted; no fixed tool-count limit`);
    for (const warning of complete.coverage.warnings) console.warn(`[generate] ${warning}`);
    const readiness = await writeAgentReadiness(agentWorkspace, discovery, tools);
    readinessFiles = readiness.files;
    if (!readiness.publicDirectory) console.log("[generate] public asset serving could not be established; deployment guidance is included in the reviewed patch");
    workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
    const cleanedImports = await removeDuplicateImports(agentWorkspace, extractUnifiedDiff(workspaceDiff).changedFiles);
    if (cleanedImports) {
      console.log(`[generate] removed identical duplicate imports in ${cleanedImports} changed source file(s)`);
      workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
    }
    try {
      await runGenerationPreflight(sitePath, agentWorkspace);
      await assertGeneratedWebMcpWiring(agentWorkspace, discovery, workspaceDiff);
      await assertGeneratedFormFeedback(agentWorkspace, tools);
    } catch (error) {
      if (error instanceof PreflightEnvironmentError || currentOperationSignal()?.aborted) throw error;
      await repairGeneratedWorkspace(opts, sitePath, agentWorkspace, provider, error);
      // A focused source fix cannot silently drop or stale the reviewed documentation.
      readinessFiles = (await writeAgentReadiness(agentWorkspace, discovery, tools)).files;
      workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
      await runGenerationPreflight(sitePath, agentWorkspace);
      await assertGeneratedWebMcpWiring(agentWorkspace, discovery, workspaceDiff);
      await assertGeneratedFormFeedback(agentWorkspace, tools);
    }
    security = auditToolSecurity(tools, discovery, sitePath, securityPolicy, { root: agentWorkspace });
  } finally {
    await removeAgentWorkspace(agentWorkspace);
  }

  try {
    const proposalFile = await writeProposedTools(sitePath, tools, discoveryPath(sitePath), draftPath);
    const securityFile = await writeSecurityReport(sitePath, security);
    if (security.status === "block") {
      throw new Error(`Security review blocked this proposal (${security.summary.block} blocking finding(s)). Inspect ${securityFile}; no pending patch was created.`);
    }
    const patch = await createPendingPatch(
      sitePath,
      workspaceDiff,
      draftPath,
      { securityPolicy, provider },
    );
    console.log(`[generate] draft saved to ${draftPath}`);
    console.log(`[generate] proposed tools: ${proposalFile}`);
    console.log(`[generate] validated ${tools.length} tool proposal(s)`);
    console.log(`[generate] security (${securityPolicy}): ${security.status} (${security.summary.review} review finding(s)); ${securityFile}`);
    console.log(`[generate] generated source changes: ${patch.changedFiles.join(", ")}`);
    console.log(`[generate] agent-readiness files included for review: ${readinessFiles.join(", ")}`);
    console.log(`[generate] patch: ${patch.patchPath}`);
    console.log("[generate] status: awaiting review");
  } catch (error) {
    console.error(`[generate] ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** A declarative proposal must include actual styles and accessible UI feedback. */
export async function assertGeneratedFormFeedback(workspace: string, tools: ProposedTool[]): Promise<void> {
  const formTools = tools.filter((tool) => tool.placement.strategy === "declarative");
  if (!formTools.length) return;
  const { discoverProject } = await import("../lib/discovery.js");
  const generated = await discoverProject(workspace);
  const contents = await Promise.all(generated.sourceFiles.map(async (file) => ({ file, text: await readFile(path.join(workspace, file), "utf8") })));
  const source = contents.filter(({ file }) => !/\.(?:css|scss)$/.test(file)).map(({ text }) => text).join("\n");
  const assetsConfig = await readFile(path.join(workspace, "angular.json"), "utf8").catch(() => "");
  const loadedStyles = contents.filter(({ file }) => /\.(?:css|scss)$/.test(file)
    && (source.includes(path.posix.basename(file)) || assetsConfig.includes(file))).map(({ text }) => text).join("\n");
  const inlineStyles = contents.filter(({ file, text }) => !/\.(?:css|scss)$/.test(file) && /<style\b|\bstyles\s*:\s*\[/.test(text)).map(({ text }) => text).join("\n");
  if (!/:tool-form-active/.test(loadedStyles + inlineStyles) || !/:tool-submit-active/.test(loadedStyles + inlineStyles)) {
    throw new Error("WebMCP forms need loaded styles for :tool-form-active and :tool-submit-active before review.");
  }
  // Each form's component must expose status text or deliberately use its existing live region.
  for (const tool of formTools) {
    const component = await readFile(path.join(workspace, tool.placement.file), "utf8");
    if (!/(?:role\s*=\s*["']status["']|aria-live\s*=\s*["']polite["'])/.test(component)
      || !/(?:toolactivated|agentInvoked)/.test(source)) {
      throw new Error(`WebMCP form "${tool.name}" needs an accessible agent-status region and activation/submit feedback before review.`);
    }
  }
}

export async function assertGeneratedWebMcpWiring(
  workspace: string,
  discovery: Awaited<ReturnType<typeof runDiscovery>>,
  diff: string,
): Promise<void> {
  const changed = diff.trim() ? extractUnifiedDiff(diff).changedFiles : [];
  const runtimeFiles = [...new Set([...discovery.sourceFiles, ...changed])].filter((file) => /\.(?:[cm]?[jt]sx?|html|vue|svelte|astro)$/i.test(file));
  const source = (await Promise.all(runtimeFiles.map(async (file) => {
    try {
      const content = await readFile(path.join(workspace, file), "utf8");
      return content.includes("<!-- webmcpify:capability-page -->") ? "" : content;
    } catch {
      return "";
    }
  }))).join("\n");
  // Inspect current runtime files, not removed lines or documentation in the
  // diff. New modules are included, but guidance alone cannot prove wiring.
  const generatedSource = source;
  const hasImperativeRuntime = /document\s*\.\s*modelContext|registerTool\s*\(/.test(generatedSource);
  const hasDeclarativeRuntime = /tool-name\s*=|toolname\s*=/.test(generatedSource);
  if (!hasImperativeRuntime && !hasDeclarativeRuntime) {
    throw new Error(
      "Generated source has no current WebMCP runtime wiring. Add document.modelContext registration or toolname/tooldescription on the real form before approval.",
    );
  }
}
