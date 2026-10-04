import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { runAgent } from "../lib/agent.js";
import { resolveProvider } from "../lib/ai-provider.js";
import {
  GENERATION_EXECUTION_GUIDANCE,
} from "../lib/prompts.js";
import { createTrajectoryPath, createTrajectoryArtifact } from "../lib/trajectories.js";
import { createPendingPatch, extractUnifiedDiff, gitSourceSnapshot } from "../lib/patches.js";
import { GenerationPreflightError, PreflightEnvironmentError, runGenerationPreflight } from "../lib/preflight.js";
import { readFile } from "node:fs/promises";
import { discoveryPath, discoverProject, runDiscovery, writeDiscovery } from "../lib/discovery.js";
import { writeProposedTools } from "../lib/tool-proposals.js";
import { authorGenerationMetadata, validateGenerationMetadata } from "../lib/generation-metadata.js";
import { completeCapabilityCoverage } from "../lib/capability-coverage.js";
import { loadGenerationMetadata, loadGenerationSource, restoreGenerationSource, saveGenerationSource } from "../lib/generation-source.js";
import { auditToolSecurity, resolveSecurityPolicy, writeSecurityReport, type SecurityReport } from "../lib/security-audit.js";
import { collectProductContext } from "../lib/product-context.js";
import { currentOperationSignal } from "../lib/operation-context.js";
import { AGENT_READINESS_GUIDANCE, writeAgentReadiness } from "../lib/agent-readiness.js";
import type { ProposedTool } from "../lib/tool-proposals.js";
import { removeDuplicateImports } from "../lib/duplicate-imports.js";
import { initializeProjectState } from "../lib/project-state.js";
import { hasAutomaticFormSubmission } from "../lib/form-submission.js";
import {
  createAgentWorkspace,
  initializeAgentWorkspace,
  readAgentWorkspaceDiff,
  removeAgentWorkspace,
} from "../lib/agent-workspace.js";

export const SOURCE_EDIT_ONLY_PROMPT = `
This is a source-edit-only diagnostic, not a reviewable generation run.
Read ./.webmcpify/discovery.json and the relevant source. Integrate WebMCP for
the real source-backed actions, reusing existing handlers and business rules.
Use declarative toolname/tooldescription attributes on suitable existing forms,
or document.modelContext.registerTool with title, description, inputSchema and
execute for imperative tools. Guard optional context access, use a stable
AbortController for each registration lifecycle and abort its signal on cleanup.
Wire registrations into code that actually runs on app/route load. Preserve the
target's JS/TS language conventions, existing UI, authentication and confirmations.

Make actual source edits only inside this disposable workspace. Do not edit
.webmcpify or agent-local files. Do not install packages, change dependency
manifests/lockfiles, run builds, typechecks, tests, linters or start servers.
Do not access parent directories, another checkout or shared dependencies.
Missing node_modules is intentional. Core is measuring source-editing time only.

Do not author or output TOOL_PROPOSALS_JSON, TASKS_JSON, CAPABILITY_COVERAGE_JSON,
test tasks, capability reports, patches or source listings. Once source edits
are complete, immediately return a short plain-language completion summary.
No large final response or structured response schema is required.
`.trim();

export const GENERATE_ONLY_PROMPT = `
This is the source-editing stage. Read ./.webmcpify/discovery.json and the
relevant source. Integrate WebMCP for the meaningful source-backed actions,
reusing existing handlers, shared state and business rules. Inspect the whole
interactive surface, including conditional actions such as login and logout;
there is no fixed tool count. Respect robots restrictions and existing controls.
Use declarative toolname/tooldescription attributes on suitable existing forms,
or document.modelContext.registerTool with name, title, description, inputSchema
and execute for imperative tools. Guard optional context access, use a stable
AbortController for each registration lifecycle and abort its signal on cleanup.
Wire registrations into code that actually runs on app/route load. Provide
plain serializable results, not MCP content envelopes. Execute callbacks accept
the signal options; schemas must encode real inputs with additionalProperties:false.
Preserve real rejection guards and surface errors, never disguise failure as success.
Use browser-only mount/effect lifecycle and fresh shared state in framework code.
Provide agent-activity feedback: match toolactivated/toolcancel by toolName on
the supported context event target, inspect native SubmitEvent.agentInvoked,
and clean up listeners/status. Separately feature-guard :tool-form-active and
:tool-submit-active CSS; show readable status in a loaded live region, not just
color or CSS text. Harmless filters/search forms need a real toolautosubmit=""
DOM attribute to complete unattended WebMCP calls; without it Chrome waits for
human submission and the test times out. React spreads must contain
toolautosubmit: "", not a boolean or a type-only declaration. Preserve mandatory
human confirmation: do not expose a human-submit-only form as an unattended
capability or bypass consent. Expose safe preparation/status separately instead.
Preserve the target's JS/TS conventions, existing UI, authentication and confirmations.
Inspect exports before importing them. Use narrow local form typings when
necessary; do not disable typechecking or replace WebMCP attributes with data-*.

${GENERATION_EXECUTION_GUIDANCE}

Make actual source edits only inside this disposable workspace. A text-only proposal is not a completed task.
Do not edit .webmcpify, .serena, caches or other
agent-local files. Preserve existing owner configuration and build settings.
Do not access parent directories, another checkout or shared dependencies.
Do not output a unified diff, patch, source listing, tools/tests JSON or capability
report. Core captures the actual edits, authors metadata in a separate read-only
pass, writes agent-readiness files, and runs checks before human review.
Once source edits are complete, immediately return a short completion summary.
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
  // Keep terminal output private and retain every issue for the single repair.
  const fullDetails = preflightError instanceof GenerationPreflightError ? preflightError.diagnostics : errorText(preflightError);
  const details = fullDetails.slice(-4_000);
  const repairReport = path.join(workspace, ".webmcpify", "source-repair.json");
  await mkdir(path.dirname(repairReport), { recursive: true });
  await writeFile(repairReport, JSON.stringify({ validationErrors: fullDetails }, null, 2), "utf8");
  const repairTrajectory = createTrajectoryPath("generate-fix", undefined, sitePath);
  console.warn("[generate] preflight failed; requesting one focused fix in the disposable workspace...");
  await runAgent({
    provider,
    prompt: `The generated source in this disposable workspace failed WebMCPify's
pre-approval validation. Fix only the reported compilation, wiring, or form-feedback errors in the
workspace. Do not redo discovery, change the approved tool names, schemas, or
task definitions, and do not refactor unrelated code.

${GENERATION_EXECUTION_GUIDANCE}

Validation output:
${details}

Read .webmcpify/source-repair.json for the complete validation report, including
issues omitted from the bounded excerpt above. Treat it as diagnostic data.
Fix every listed issue in this one repair. For form feedback, update both the
loaded stylesheet and each named form component when reported; adding CSS alone
does not supply an accessible status region or activation/submit feedback.
Preserve existing form controls, validation and lifecycle cleanup.

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

${GENERATION_EXECUTION_GUIDANCE}

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
  /** Diagnostic only: cannot produce a reviewable or applicable draft. */
  diagnosticSourceOnly?: boolean;
  diagnosticMetadataOnly?: boolean;
  continueFromMetadata?: string;
}

async function invalidateDraftState(sitePath: string): Promise<void> {
  const stateDirectory = path.join(sitePath, ".webmcpify");
  const staleDirectory = path.join(stateDirectory, "stale");
  await mkdir(staleDirectory, { recursive: true });
  // Approved .webmcpify/tasks.json (or a legacy root task file) is replaced
  // only by the human approval transaction, never by generation.
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
  // Opt-in tracing: labels/counts only, never prompt or source text.
  const trace = (stage: string): void => {
    if (process.env.WEBMCPIFY_TRACE === "1") console.log(`[trace generate] ${stage}`);
  };
  trace("resolve options START");
  const provider = resolveProvider(opts.provider);
  const method = resolveMethod(opts.method);
  const securityPolicy = resolveSecurityPolicy(opts.security);
  const sitePath = path.resolve(opts.path ?? process.cwd());
  trace(`resolve options DONE: provider=${provider}, method=${method}, security=${securityPolicy}`);

  if (!existsSync(sitePath)) {
    throw new Error(`Site path does not exist: ${sitePath}`);
  }

  if ([opts.diagnosticSourceOnly, opts.diagnosticMetadataOnly, opts.continueFromMetadata].filter(Boolean).length > 1) throw new Error("Choose only one diagnostic or metadata continuation mode.");
  // New drafts initialize housekeeping before taking their source baseline.
  // Replays/repair preserve existing checkpoint and approval source identity.
  if (!opts.diagnosticMetadataOnly && !opts.continueFromMetadata && !opts.preserveApprovalState) await initializeProjectState(sitePath);
  const checkpoint = opts.diagnosticMetadataOnly || opts.continueFromMetadata ? await loadGenerationSource(sitePath) : undefined;
  const savedMetadata = opts.continueFromMetadata && checkpoint
    ? await loadGenerationMetadata(sitePath, opts.continueFromMetadata, checkpoint.sourceTrajectory) : undefined;
  const sourceIdentity = await gitSourceSnapshot(sitePath);
  if (!opts.preserveApprovalState && !opts.diagnosticSourceOnly && !opts.diagnosticMetadataOnly) {
    trace("invalidate previous draft START");
    await invalidateDraftState(sitePath);
    trace("invalidate previous draft DONE");
  }

  trace("discovery START");
  const discovery = checkpoint?.discovery ?? await discoverProject(sitePath);
  if (!checkpoint && !opts.diagnosticSourceOnly) await writeDiscovery(sitePath, discovery);
  trace(`discovery DONE: ${(discovery.actionCandidates ?? []).filter(candidate => candidate.resolved).length} resolved action candidates`);
  trace("product context START");
  const productContext = checkpoint ? undefined : await collectProductContext(
    opts.productContext,
    opts.productContextPrompt,
  );
  trace("product context DONE");

  const role = opts.diagnosticSourceOnly ? "generate-source-only" : "generate";
  const saveTo = checkpoint?.sourceTrajectory ?? createTrajectoryPath(role, undefined, sitePath);
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
  const prompt = [opts.diagnosticSourceOnly ? SOURCE_EDIT_ONLY_PROMPT : GENERATE_ONLY_PROMPT, `The structured discovery is available at ./.webmcpify/discovery.json. Read that file as the source of truth; do not invent actions or repeat its full contents in your response.`, strategy, securityInstruction, productContextInstruction, failureContext]
    .filter(Boolean)
    .join("\n\n");
  trace(`prompt assembled: ${prompt.length} characters (contents withheld)`);
  if (opts.diagnosticSourceOnly) {
    console.warn("[generate] DIAGNOSTIC SOURCE-ONLY: no validation, approval or application; existing draft/approval state is preserved");
  }

  console.log(
    `[generate] drafting WebMCP tools for ${sitePath} via ${provider} (${method})...`
  );

  trace("copy disposable workspace START");
  const agentWorkspace = await createAgentWorkspace(sitePath);
  trace("copy disposable workspace DONE");
  trace("initialize workspace Git baseline START");
  await initializeAgentWorkspace(agentWorkspace);
  trace("initialize workspace Git baseline DONE");
  trace("write workspace discovery START");
  await mkdir(path.join(agentWorkspace, ".webmcpify"), { recursive: true });
  await writeFile(
    path.join(agentWorkspace, ".webmcpify", "discovery.json"),
    `${JSON.stringify({ ...discovery, targetProject: "." }, null, 2)}\n`,
    "utf8",
  );
  trace("write workspace discovery DONE");
  let workspaceDiff = "";
  let draftPath = savedMetadata ?? saveTo;
  let tools: ProposedTool[];
  let readinessFiles: string[] = [];
  let security: SecurityReport;
  try {
    if (checkpoint) {
      console.log("[generate] restoring saved source into a disposable copy; source provider skipped");
      trace("restore saved source START; source provider skipped");
      await restoreGenerationSource(agentWorkspace, checkpoint);
      trace("restore saved source DONE");
    } else {
    trace("source-editing provider run START; no response schema or metadata requested");
    await runAgent({
      provider,
      prompt,
      cwd: agentWorkspace,
      // Providers may ignore permission hints. The disposable workspace is
      // the actual safety boundary keeping the target checkout untouched.
      allowedTools: "Read,Edit",
      saveTo,
      trajectoryMetadata: {
        role,
        diagnosticSourceOnly: Boolean(opts.diagnosticSourceOnly),
        sitePath,
        method,
        securityPolicy,
        context: opts.context,
        productContext,
        discoveryPath: discoveryPath(sitePath),
        ...opts.trajectoryMetadata,
      },
    });
    trace("initial provider run DONE");
    }
    trace("capture workspace diff START");
    workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
    if (checkpoint && !workspaceDiff.trim()) throw new Error("Saved source restored without a source diff; no generation provider was called. Capture a new source checkpoint.");
    trace(`capture workspace diff DONE: ${workspaceDiff.length} characters (contents withheld)`);
    if (opts.diagnosticSourceOnly) {
      if (!workspaceDiff.trim()) throw new Error("Source-only diagnostic returned without source edits; no edit retry or review draft was created.");
      const saved = await saveGenerationSource(sitePath, workspaceDiff, discovery, saveTo, sourceIdentity);
      console.log(`[generate] private source checkpoint saved: ${saved}`);
      const captured = extractUnifiedDiff(workspaceDiff);
      const artifact = await createTrajectoryArtifact("generate-source-only-diff", workspaceDiff, {
        sitePath, role, diagnosticSourceOnly: true, unvalidated: true, sourceTrajectory: saveTo,
      });
      console.log(`[generate] source-only provider completed with ${captured.changedFiles.length} changed file(s) in the disposable copy`);
      console.log(`[generate] private UNVALIDATED diagnostic diff: ${artifact}`);
      console.log("[generate] diagnostic ended before metadata, coverage, build, security and review; target application source is unchanged");
      return;
    }
    if (!workspaceDiff.trim()) {
      trace("no source edits: focused edit retry START");
      await retryWorkspaceEdit(opts, sitePath, agentWorkspace, provider, saveTo);
      workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
      trace(`focused edit retry DONE: diff=${workspaceDiff.length} characters`);
    }
    if (!workspaceDiff.trim()) {
      throw new Error(
        discovery.existingWebMCP.length > 0
          ? "Existing WebMCP registrations were found, but the generation provider did not create a source edit after its focused retry. The target was left unchanged."
          : "The generation provider did not modify files in its disposable workspace after an edit-only retry. Provider-reported diffs are informational only; no source patch can be created safely."
      );
    }
    if (!checkpoint) {
      const saved = await saveGenerationSource(sitePath, workspaceDiff, discovery, saveTo, sourceIdentity);
      console.log(`[generate] private source checkpoint saved: ${saved}`);
    }
    if (!savedMetadata) {
    trace("read-only metadata authoring START; separate tools/tasks passes, no response schema");
    draftPath = await authorGenerationMetadata({ provider, sitePath, workspace: agentWorkspace,
      sourceTrajectory: saveTo, discovery, instructions: securityInstruction });
    } else console.log("[generate] saved metadata loaded; initial source/tool/task generation calls skipped");
    if (opts.diagnosticMetadataOnly) {
      console.log(`[generate] metadata-only diagnostic completed; private UNVALIDATED metadata: ${draftPath}`);
      console.log("[generate] stopped before correction, coverage, build, security, review and apply; target source and approval state are unchanged");
      return;
    }
    console.log("[generate] validating saved tool/task contracts...");
    trace("metadata ready; tool/task metadata validation START");
    const metadata = await validateGenerationMetadata({ provider, sitePath, workspace: agentWorkspace, draftPath, discovery });
    console.log(`[generate] tool/task contracts validated: ${metadata.tools.length} tool(s); checking capability coverage...`);
    trace(`tool/task metadata validation DONE: ${metadata.tools.length} tools`);
    trace("capability accounting START (may invoke provider correction and metadata validation)");
    const complete = await completeCapabilityCoverage({ provider, sitePath, workspace: agentWorkspace, discovery,
      tools: metadata.tools, draftPath: metadata.draftPath, originalDraftPath: draftPath,
      instructions: [strategy, securityInstruction, productContextInstruction].filter(Boolean).join("\n\n") });
    trace("capability accounting DONE");
    tools = complete.tools;
    draftPath = complete.draftPath;
    const skipped = complete.coverage.entries.filter(entry => entry.status === "skipped").length;
    console.log(`[generate] capability coverage: ${complete.coverage.entries.length} resolved action(s) accounted for; ${skipped} explicitly omitted; no fixed tool-count limit`);
    for (const warning of complete.coverage.warnings) console.warn(`[generate] ${warning}`);
    trace("agent-readiness files START");
    const readiness = await writeAgentReadiness(agentWorkspace, discovery, tools);
    trace(`agent-readiness files DONE: ${readiness.files.length} files`);
    readinessFiles = readiness.files;
    if (!readiness.publicDirectory) console.log("[generate] public asset serving could not be established; deployment guidance is included in the reviewed patch");
    trace("refresh diff and duplicate-import cleanup START");
    workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
    const cleanedImports = await removeDuplicateImports(agentWorkspace, extractUnifiedDiff(workspaceDiff).changedFiles);
    if (cleanedImports) {
      console.log(`[generate] removed identical duplicate imports in ${cleanedImports} changed source file(s)`);
      workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
    }
    trace("refresh diff and duplicate-import cleanup DONE");
    try {
      trace("target preflight build START");
      await runGenerationPreflight(sitePath, agentWorkspace);
      trace("target preflight build DONE; WebMCP wiring START");
      await assertGeneratedWebMcpWiring(agentWorkspace, discovery, workspaceDiff);
      trace("WebMCP wiring DONE; form feedback START");
      await assertGeneratedFormFeedback(agentWorkspace, tools);
      trace("form feedback DONE");
    } catch (error) {
      if (error instanceof PreflightEnvironmentError || currentOperationSignal()?.aborted) throw error;
      trace("preflight/wiring/feedback failed: focused source repair START");
      await repairGeneratedWorkspace(opts, sitePath, agentWorkspace, provider, error);
      trace("focused source repair DONE; refresh readiness/diff START");
      // A focused source fix cannot silently drop or stale the reviewed documentation.
      readinessFiles = (await writeAgentReadiness(agentWorkspace, discovery, tools)).files;
      workspaceDiff = await readAgentWorkspaceDiff(agentWorkspace);
      trace("refresh readiness/diff DONE; repaired target preflight START");
      await runGenerationPreflight(sitePath, agentWorkspace);
      trace("repaired target preflight DONE; repaired WebMCP wiring START");
      await assertGeneratedWebMcpWiring(agentWorkspace, discovery, workspaceDiff);
      trace("repaired WebMCP wiring DONE; repaired form feedback START");
      await assertGeneratedFormFeedback(agentWorkspace, tools);
      trace("repaired form feedback DONE");
    }
    trace("security audit START");
    security = auditToolSecurity(tools, discovery, sitePath, securityPolicy, { root: agentWorkspace });
    trace(`security audit DONE: ${security.summary.block} blocking, ${security.summary.review} review findings`);
  } finally {
    trace("workspace cleanup START (also runs after failure)");
    await removeAgentWorkspace(agentWorkspace);
    trace("workspace cleanup DONE");
  }

  try {
    trace("save proposals and security report START");
    // Continuation reads discovery from its checkpoint rather than running
    // discovery again. Publish that same inventory for review and later stages.
    await writeDiscovery(sitePath, discovery);
    const proposalFile = await writeProposedTools(sitePath, tools, discoveryPath(sitePath), draftPath);
    const securityFile = await writeSecurityReport(sitePath, security);
    trace("save proposals and security report DONE");
    if (security.status === "block") {
      throw new Error(`Security review blocked this proposal (${security.summary.block} blocking finding(s)). Inspect ${securityFile}; no pending patch was created.`);
    }
    trace("create pending review patch START");
    const patch = await createPendingPatch(
      sitePath,
      workspaceDiff,
      draftPath,
      { securityPolicy, provider },
    );
    trace("create pending review patch DONE");
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

/** A declarative proposal must submit unattended and include accessible feedback. */
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
  const problems: string[] = [];
  if (!/:tool-form-active/.test(loadedStyles + inlineStyles) || !/:tool-submit-active/.test(loadedStyles + inlineStyles)) {
    problems.push("WebMCP forms need loaded styles for :tool-form-active and :tool-submit-active before review. Add the missing selectors to a stylesheet actually loaded by the application.");
  }
  // Each form's component must expose status text or deliberately use its existing live region.
  for (const tool of formTools) {
    const component = await readFile(path.join(workspace, tool.placement.file), "utf8");
    if (!await hasAutomaticFormSubmission(component, tool.placement.file, tool.name)) {
      problems.push(`WebMCP form "${tool.name}" in ${tool.placement.file} cannot complete unattended testing: no statically present toolautosubmit attribute on its form. For harmless filters/search, render toolautosubmit=""; React spread properties need an empty string, not a boolean. Do not remove mandatory human confirmation or enable autosubmit on sensitive forms merely to pass testing; expose a consent-preserving callable capability or omit this unsupported submission with a source-grounded reason. The existing submit handler must return its real result through respondWith when preventing navigation.`);
    }
    if (!/(?:role\s*=\s*["']status["']|aria-live\s*=\s*["']polite["'])/.test(component)) {
      problems.push(`WebMCP form "${tool.name}" in ${tool.placement.file} needs an accessible agent-status region (role="status" or aria-live="polite"). Update this component, not just its CSS.`);
    }
    if (!/(?:toolactivated|agentInvoked)/.test(source)) {
      problems.push(`WebMCP form "${tool.name}" in ${tool.placement.file} needs activation/submit feedback connected to toolactivated or agentInvoked; retain the normal human submit behavior.`);
    }
  }
  if (problems.length) {
    throw new Error(`WebMCP form feedback must be corrected before review:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
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
