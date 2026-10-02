import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { currentOperationSignal, withOperationSignal } from "../dist/lib/operation-context.js";
import { resolvePackageManager } from "../dist/lib/package-manager.js";

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
  for (const directory of [".serena", "nested/.serena"]) {
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
  assert.doesNotMatch(diff, /\.serena/, "Agent-generated state must not enter a pending source patch");
  await git(workspace, ["add", "-f", "--", ".serena/project.yml", "nested/.serena/project.yml"]);
  assert.equal(await readAgentWorkspaceDiff(workspace), diff, "Even force-staged Serena files must be excluded from patch capture");
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
  for (const unsafe of ["../outside.js", ".git/config", ".webmcpify/private.json", ".serena/project.yml", "nested/.serena/cache.json", "C:/outside.js"]) {
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
  await writeFile(config, JSON.stringify({ mcpServers: { "browser.with.dot": { command: "fixture-mcp", args: ["arg"], env: { "KEY.with.dot": "synthetic-value" } } } }));
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
      assert.equal(captured.config.mcp["browser.with.dot"].type, "local");
      assert.equal(captured.config.mcp.servers, undefined);
      assert.equal(await readFile(path.join(browserWorkspace, "opencode.json"), "utf8"), '{"model":"owner-model"}');
    } else if (provider === "gemini") {
      assert.equal(captured.config.ui.theme, "owner-theme");
      assert.equal(captured.config.mcpServers["browser.with.dot"].command, "fixture-mcp");
    } else if (provider === "codex") {
      assert.ok(captured.argv.includes('mcp_servers."browser.with.dot".env."KEY.with.dot"="synthetic-value"'));
    }
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
    assert.equal(currentOperationSignal(), controller.signal);
    return "activity result";
  }), "activity result");
  assert.equal(heartbeats, 1);
  assert.equal(currentOperationSignal(), undefined, "Concurrent operation signals must not leak outside their context");
  const sleeper = await fixtureProvider(root, "cancel-provider", "setInterval(() => {}, 1000);");
  process.env.WEBMCPIFY_OPENCODE_BIN = sleeper;
  const cancellation = withOperationSignal(controller.signal, () => runAgent({ provider: "opencode", prompt: "private fixture", cwd: browserWorkspace, saveTo: path.join(root, "cancel.json") }));
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(cancellation, /agent failed/);
  const packageManagerSite = path.join(root, "package-manager");
  await mkdir(packageManagerSite);
  delete process.env.WEBMCPIFY_PACKAGE_MANAGER;
  await writeFile(path.join(packageManagerSite, "package.json"), '{"packageManager":"yarn@4.0.0"}');
  assert.equal(await resolvePackageManager(packageManagerSite), "yarn");
  await writeFile(path.join(packageManagerSite, "bun.lock"), "");
  assert.equal(await resolvePackageManager(packageManagerSite), "bun");
  console.log("Runtime safety verification passed: worktrees, patch paths/hash, untracked changes, source-free browser workspaces, provider MCP adapters, Temporal settings");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
