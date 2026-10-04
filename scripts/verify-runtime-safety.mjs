import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fixtureProvider } from "./fixture-provider.mjs";
import { createAgentWorkspace, createBrowserAgentWorkspace, initializeAgentWorkspace, readAgentWorkspaceDiff } from "../dist/lib/agent-workspace.js";
import { createPendingPatch, extractUnifiedDiff, gitSourceSnapshot } from "../dist/lib/patches.js";
import { runApply } from "../dist/commands/apply.js";
import { runAgent, getInvocation } from "../dist/lib/agent.js";
import { temporalConnectionOptions } from "../dist/lib/temporal.js";
import { coreActivityContext } from "../dist/temporal/activity-context.js";
import { currentOperationDeadline, currentOperationSignal, withOperationSignal, withOperationDeadline } from "../dist/lib/operation-context.js";
import { resolvePackageManager } from "../dist/lib/package-manager.js";
import { executableOnPath } from "../dist/lib/executables.js";
import { PreflightEnvironmentError, runGenerationPreflight } from "../dist/lib/preflight.js";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-runtime-"));
const exec = promisify(execFile);
const git = (cwd, args) => exec("git", args, { cwd });
const env = { ...process.env };
const workspaces = [];
try {
  const repository = path.join(root, "repo");
  await mkdir(repository);
  await writeFile(path.join(repository, "source.js"), "export const value = 1;\n");
  await git(repository, ["init", "-q"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await git(repository, ["config", "user.name", "Runtime fixture"]);
  await git(repository, ["add", "-A"]);
  await git(repository, ["commit", "-qm", "baseline"]);
  const worktree = path.join(root, "worktree");
  await git(repository, ["worktree", "add", "-q", "-b", "fixture-worktree", worktree]);
  await mkdir(path.join(worktree, ".webmcpify"));
  await writeFile(path.join(worktree, ".webmcpify", "private.json"), "private fixture");
  await mkdir(path.join(worktree, "node_modules"));
  await mkdir(path.join(worktree, ".serena"));
  await writeFile(path.join(worktree, ".serena", "project.yml"), "owner configuration\n");
  await mkdir(path.join(worktree, "nested", ".serena"), { recursive: true });
  await writeFile(path.join(worktree, "nested", ".serena", "cache.json"), "owner cache\n");
  const workspace = await createAgentWorkspace(worktree);
  workspaces.push(workspace);
  for (const excluded of [".git", ".webmcpify", ".serena", "nested/.serena", "node_modules"]) await assert.rejects(access(path.join(workspace, excluded)));
  await initializeAgentWorkspace(workspace);
  const generatedState = [".serena", "nested/.serena", "node_modules", "nested/node_modules", ".pnpm-store", "nested/.pnpm-store"];
  for (const directory of generatedState) {
    await mkdir(path.join(workspace, directory), { recursive: true });
    await writeFile(path.join(workspace, directory, "project.yml"), "agent configuration\n");
  }
  const filenames = ["Component Copy.jsx", "café.jsx", "dir b/binary b/file.bin", "quote\"file.jsx"];
  if (process.platform === "win32") filenames.pop();
  for (const filename of filenames) {
    await mkdir(path.dirname(path.join(workspace, filename)), { recursive: true });
    await writeFile(path.join(workspace, filename), filename.endsWith(".bin") ? Buffer.from([0, 1, 2, 3]) : "export const fixture = true;\n");
  }
  const diff = await readAgentWorkspaceDiff(workspace);
  assert.doesNotMatch(diff, /\.serena|node_modules|\.pnpm-store/, "Agent-generated state must not enter a pending source patch");
  await git(workspace, ["add", "-f", "--", ...generatedState.map(directory => `${directory}/project.yml`)]);
  assert.equal(await readAgentWorkspaceDiff(workspace), diff, "Even force-staged agent/dependency state must be excluded from patch capture");
  assert.equal(await readFile(path.join(worktree, ".serena", "project.yml"), "utf8"), "owner configuration\n", "Existing owner configuration must remain untouched");
  const extracted = extractUnifiedDiff(diff);
  assert.deepEqual(extracted.changedFiles.sort(), filenames.sort(), "All spaced/quoted/Unicode patch paths must be represented");
  const metadata = await createPendingPatch(worktree, diff, "fixture.json");
  await writeFile(path.join(worktree, ".webmcpify", "approved-tools.json"), JSON.stringify({ sourceDiff: { status: "approved", runId: metadata.runId, patchHash: metadata.patchHash } }));
  await writeFile(metadata.patchPath, (await readFile(metadata.patchPath, "utf8")).replace("fixture = true", "fixture = false"));
  await assert.rejects(runApply({ path: worktree }), /patch changed/);
  await assert.rejects(access(path.join(worktree, filenames[0])), undefined, "Tampering must not apply source");
  await writeFile(path.join(repository, "untracked.js"), "first");
  const before = await gitSourceSnapshot(repository);
  await writeFile(path.join(repository, "untracked.js"), "second");
  assert.notEqual((await gitSourceSnapshot(repository)).workingTreeHash, before.workingTreeHash, "Untracked source content changes invalidate approval");
  for (const unsafe of ["../outside.js", ".git/config", ".webmcpify/private.json", ".serena/project.yml", "nested/.serena/cache.json", "node_modules/dependency.js", "nested/node_modules/dependency.js", ".pnpm-store/cache.json", "nested/.pnpm-store/cache.json", "C:/outside.js"]) {
    assert.throws(() => extractUnifiedDiff(`diff --git a/${unsafe} b/${unsafe}\n--- a/${unsafe}\n+++ b/${unsafe}\n@@ -1 +1 @@\n-old\n+new\n`));
  }
  const browserWorkspace = await createBrowserAgentWorkspace();
  workspaces.push(browserWorkspace);
  await assert.rejects(access(path.join(browserWorkspace, "source.js")), undefined, "Browser agents must not receive source copies");

  const captureProvider = await fixtureProvider(root, "capture-provider", `
import { readFileSync, writeFileSync } from 'node:fs';
const provider = process.env.FIXTURE_PROVIDER;
let config;
if (provider === 'opencode') config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
if (provider === 'gemini') config = JSON.parse(readFileSync('.gemini/settings.json', 'utf8'));
writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), config }));
process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'fixture complete' } }) + String.fromCharCode(10));
`);
  const config = path.join(root, "mcp.json");
  await writeFile(config, JSON.stringify({ mcpServers: { "browser-server": { command: "fixture-mcp", args: ["arg"], env: { "FIXTURE_KEY": "synthetic-value" } } } }));
  process.env.FIXTURE_CAPTURE = path.join(root, "capture.json");
  for (const provider of ["opencode", "gemini", "codex", "claude"]) {
    process.env[`WEBMCPIFY_${provider.toUpperCase()}_BIN`] = captureProvider;
    process.env.FIXTURE_PROVIDER = provider;
    await writeFile(path.join(browserWorkspace, "opencode.json"), '{"model":"owner-model"}');
    await mkdir(path.join(browserWorkspace, ".gemini"), { recursive: true });
    await writeFile(path.join(browserWorkspace, ".gemini", "settings.json"), '{"ui":{"theme":"owner-theme"}}');
    await runAgent({ provider, prompt: "fixture prompt", cwd: browserWorkspace, mcpConfig: config, saveTo: path.join(root, `${provider}.json`) });
    const captured = JSON.parse(await readFile(process.env.FIXTURE_CAPTURE, "utf8"));
    if (provider === "opencode") {
      assert.ok(captured.argv.includes("--auto"));
      assert.ok(!captured.argv.includes("--dangerously-skip-permissions"));
      assert.equal(captured.config.mcp["browser-server"].type, "local");
      assert.equal(captured.config.mcp.servers, undefined);
      assert.equal(await readFile(path.join(browserWorkspace, "opencode.json"), "utf8"), '{"model":"owner-model"}');
    } else if (provider === "gemini") {
      assert.equal(captured.config.ui.theme, "owner-theme");
      assert.equal(captured.config.mcpServers["browser-server"].command, "fixture-mcp");
    } else if (provider === "codex") {
      assert.ok(captured.argv.includes('mcp_servers.browser-server.env.FIXTURE_KEY="synthetic-value"'));
    }
  }
  for (const server of [
    { "browser.with.dot": { command: "fixture-mcp" } },
    { browser: { command: "fixture-mcp", env: { "KEY.with.dot": "synthetic-value" } } },
  ]) {
    await writeFile(config, JSON.stringify({ mcpServers: server }));
    await assert.rejects(runAgent({ provider: "codex", prompt: "fixture prompt", cwd: browserWorkspace, mcpConfig: config, saveTo: path.join(root, "invalid-codex.json") }), /dots and quotes are not supported/);
  }
  assert.ok(getInvocation({ provider: "opencode", prompt: "fixture", cwd: root, saveTo: "fixture.json" }).args.includes("--format"));
  process.env.WEBMCPIFY_TEMPORAL_ADDRESS = "fixture.example:7233";
  process.env.WEBMCPIFY_TEMPORAL_TLS = "true";
  process.env.WEBMCPIFY_TEMPORAL_API_KEY = "synthetic-key";
  assert.deepEqual(temporalConnectionOptions(), { address: "fixture.example:7233", tls: true, apiKey: "synthetic-key" });
  process.env.WEBMCPIFY_TEMPORAL_TLS = "invalid";
  assert.throws(temporalConnectionOptions, /must be true or false/);
  const controller = new AbortController();
  let heartbeats = 0;
  const interceptor = coreActivityContext({ cancellationSignal: controller.signal, heartbeat() { heartbeats++; } });
  assert.equal(await interceptor.inbound.execute({ args: [] }, async () => {
    assert.equal(currentOperationSignal().aborted, false);
    return "activity result";
  }), "activity result");
  assert.equal(heartbeats, 1);
  assert.equal(currentOperationSignal(), undefined, "Concurrent operation signals must not leak outside their context");
  const sdkCancellation = new Error("synthetic SDK cancellation");
  const cancelledContext = { cancellationSignal: controller.signal, cancelled: new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(sdkCancellation), { once: true });
  }), heartbeat() {} };
  const cancelledActivity = coreActivityContext(cancelledContext).inbound.execute({ args: [] }, async () => {
    await new Promise(resolve => currentOperationSignal().addEventListener("abort", resolve, { once: true }));
    return "command swallowed cancellation";
  });
  controller.abort();
  await assert.rejects(cancelledActivity, error => error === sdkCancellation, "Caught command cancellation must not become activity success");
  const beatFailure = new Error("synthetic heartbeat failure");
  const brokenHeartbeat = coreActivityContext({ cancellationSignal: new AbortController().signal, heartbeat() { throw beatFailure; } });
  await assert.rejects(brokenHeartbeat.inbound.execute({ args: [] }, async () => assert.fail("No command may start after heartbeat fails")), error => error === beatFailure);
  const deadlineContext = coreActivityContext({ info: { startToCloseTimeoutMs: 30 }, cancellationSignal: new AbortController().signal, heartbeat() {} });
  await assert.rejects(deadlineContext.inbound.execute({ args: [] }, async () => {
    assert.ok(currentOperationDeadline() > Date.now());
    await new Promise(resolve => currentOperationSignal().addEventListener('abort', resolve, { once: true }));
    return 'build swallowed its local deadline';
  }), /activity deadline elapsed/, 'A lost service connection must not disable local operation deadlines');
  assert.equal(currentOperationDeadline(), undefined);
  const longContext = coreActivityContext({ info: { startToCloseTimeoutMs: 365 * 24 * 3600000 }, cancellationSignal: new AbortController().signal, heartbeat() {} });
  assert.equal(await longContext.inbound.execute({ args: [] }, async () => 'long owner-review budget'), 'long owner-review budget', 'Long deadlines must not overflow Node timers');
  const longAgy = await withOperationDeadline(Date.now() + 3600000, async () => getInvocation({ provider: 'antigravity', prompt: 'fixture', cwd: root, saveTo: 'test-fixture.json', trajectoryMetadata: {role:'test'} }));
  assert.notEqual(longAgy.args[longAgy.args.indexOf('--print-timeout')+1], '5m', 'Durable provider defaults must use the owner-selected activity budget');
  const providerController = new AbortController();
  const sleeper = await fixtureProvider(root, "cancel-provider", "setInterval(() => {}, 1000);");
  process.env.WEBMCPIFY_OPENCODE_BIN = sleeper;
  const cancellation = withOperationSignal(providerController.signal, () => runAgent({ provider: "opencode", prompt: "private fixture", cwd: browserWorkspace, saveTo: path.join(root, "cancel.json") }));
  setTimeout(() => providerController.abort(), 200);
  await assert.rejects(cancellation, /agent failed/);
  const packageManagerSite = path.join(root, "package-manager");
  await mkdir(packageManagerSite);
  delete process.env.WEBMCPIFY_PACKAGE_MANAGER;
  await writeFile(path.join(packageManagerSite, "package.json"), '{"packageManager":"yarn@4.0.0"}');
  assert.equal(path.basename(await resolvePackageManager(packageManagerSite)).replace(/\.(cmd|exe|bat)$/i, ""), "yarn");
  await writeFile(path.join(packageManagerSite, "bun.lock"), "");
  assert.equal(path.basename(await resolvePackageManager(packageManagerSite)).replace(/\.(cmd|exe|bat)$/i, ""), "bun");
  const manager = await fixtureProvider(root, "check-manager", "if(process.env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN!=='false')throw new Error('Unsafe automatic dependency installation');process.exit(0);");
  process.env.WEBMCPIFY_PACKAGE_MANAGER = path.relative(process.cwd(), manager);
  assert.equal(await resolvePackageManager(packageManagerSite), manager, "Relative overrides must be anchored before switching cwd");
  await writeFile(path.join(packageManagerSite, "package.json"), '{"scripts":{"build":"fixture-check"}}');
  await mkdir(path.join(packageManagerSite, "node_modules"));
  if (process.platform !== "win32") await symlink(path.join(root, "nonexistent-optional-dependency"), path.join(packageManagerSite, "node_modules", "stale-optional"));
  const preflightWorkspace = path.join(root, "preflight-workspace");
  await mkdir(preflightWorkspace);
  await runGenerationPreflight(packageManagerSite, preflightWorkspace);
  // pnpm's real default before-run install must not touch a linked target tree.
  await writeFile(path.join(packageManagerSite, "source.js"), "export const value=1;\n");
  await writeFile(path.join(packageManagerSite, "package.json"), '{"scripts":{"build":"node --check source.js"}}');
  await writeFile(path.join(packageManagerSite, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  await writeFile(path.join(packageManagerSite, "node_modules", "owner-sentinel"), "owner dependency tree\n");
  const realPnpmWorkspace = path.join(root, "pnpm-preflight");
  await mkdir(realPnpmWorkspace);
  await writeFile(path.join(realPnpmWorkspace, "source.js"), "export const value=1;\n");
  await writeFile(path.join(realPnpmWorkspace, "package.json"), '{"scripts":{"build":"node --check source.js"}}');
  delete process.env.WEBMCPIFY_PACKAGE_MANAGER;
  if (executableOnPath("pnpm")) await runGenerationPreflight(packageManagerSite, realPnpmWorkspace);
  else console.log("Real pnpm integration skipped: pnpm is not installed; subprocess configuration and no-TTY regression checks still run");
  assert.equal(await readFile(path.join(packageManagerSite, "node_modules", "owner-sentinel"), "utf8"), "owner dependency tree\n");
  const pureJsSite = path.join(root, 'pure-js');
  const pureJsWorkspace = path.join(root, 'pure-js-workspace');
  await mkdir(pureJsSite); await mkdir(pureJsWorkspace);
  for (const dir of [pureJsSite, pureJsWorkspace]) await writeFile(path.join(dir, 'package.json'), '{"scripts":{"build":"node --check source.js"}}');
  await writeFile(path.join(pureJsWorkspace, 'source.js'), 'this is invalid JavaScript');
  process.env.WEBMCPIFY_PACKAGE_MANAGER = 'npm';
  await assert.rejects(runGenerationPreflight(pureJsSite, pureJsWorkspace), /did not pass build/, 'Dependency-free JS builds must run even without node_modules');
  for (const dir of [pureJsSite, pureJsWorkspace]) await writeFile(path.join(dir, 'package.json'), '{"scripts":{"typecheck":"node --check build.js","build":"node --check source.js"}}');
  await writeFile(path.join(pureJsWorkspace, 'build.js'), 'const typesAreValid = true;\n');
  await assert.rejects(runGenerationPreflight(pureJsSite, pureJsWorkspace), /did not pass build/, 'A typecheck mentioning build must not skip the actual build');
  for (const manifest of ['null', '[]', '{broken-json', '{"scripts":{"typecheck":42}}', '{"dependencies":"invalid-map"}']) {
    await writeFile(path.join(pureJsSite, 'package.json'), manifest);
    await assert.rejects(runGenerationPreflight(pureJsSite, pureJsWorkspace), error => error instanceof PreflightEnvironmentError && /package.json/.test(error.message), 'Malformed target manifests must not silently disable preflight');
  }
  const interactiveManager = await fixtureProvider(root, "interactive-manager", "process.stderr.write('[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY');process.exit(1);");
  process.env.WEBMCPIFY_PACKAGE_MANAGER = interactiveManager;
  await assert.rejects(runGenerationPreflight(packageManagerSite, preflightWorkspace), error => {
    assert.ok(error instanceof PreflightEnvironmentError);
    assert.match(error.message, /interactive pnpm dependency install/);
    assert.doesNotMatch(error.message, /Generated source|ERR_PNPM|Command failed/);
    return true;
  });
  process.env.WEBMCPIFY_PACKAGE_MANAGER = path.join(root, "missing-manager");
  await assert.rejects(runGenerationPreflight(packageManagerSite, preflightWorkspace), (error) => {
    assert.ok(error instanceof PreflightEnvironmentError);
    assert.match(error.message, /WEBMCPIFY_PACKAGE_MANAGER/);
    assert.doesNotMatch(error.message, /fixture-check|Command failed|spawn /);
    return true;
  });
  console.log("Runtime safety verification passed: worktrees, patch paths/hash, untracked changes, source-free browser workspaces, provider MCP adapters, Temporal settings");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
