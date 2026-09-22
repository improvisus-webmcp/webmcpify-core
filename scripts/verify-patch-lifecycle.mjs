import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createPendingPatch, readPatchMetadata } from "../dist/lib/patches.js";
import { runApply } from "../dist/commands/apply.js";

const exec = promisify(execFile);
const git = (cwd, args) => exec("git", args, { cwd });
const original = "export const value = 'before';\n";

async function fixture(buildScript) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "webmcpify-patch-"));
  await writeFile(path.join(dir, "source.js"), original);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: buildScript ? { build: buildScript } : {} }));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "WebMCPify test"]);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-qm", "fixture"]);
  return dir;
}

async function makePatch(dir) {
  await writeFile(path.join(dir, "source.js"), "export const value = 'after';\n");
  const { stdout } = await git(dir, ["diff", "--no-ext-diff"]);
  await writeFile(path.join(dir, "source.js"), original);
  return stdout;
}

async function approve(dir, metadata) {
  await writeFile(path.join(dir, ".webmcpify", "approved-tools.json"), JSON.stringify({
    sourceDiff: { status: "approved", runId: metadata.runId },
  }));
}

async function main() {
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";

  const valid = await fixture();
  const patch = await makePatch(valid);
  const metadata = await createPendingPatch(valid, patch, "generation.json", { securityPolicy: "balance" });
  assert.equal(metadata.securityPolicy, "balance");
  await approve(valid, metadata);
  await runApply({ path: valid });
  assert.equal(await readFile(path.join(valid, "source.js"), "utf8"), "export const value = 'after';\n");

  const missingApproval = await fixture();
  await createPendingPatch(missingApproval, await makePatch(missingApproval), "generation.json");
  await assert.rejects(() => runApply({ path: missingApproval }), /approved source diff/);

  const invalid = await fixture();
  await assert.rejects(() => createPendingPatch(invalid, "diff --git a/source.js b/source.js\n@@ invalid", "generation.json"), /did not produce an applicable source diff/);

  const failedBuild = await fixture("node -e \"process.exit(1)\"");
  const failedPatch = await createPendingPatch(failedBuild, await makePatch(failedBuild), "generation.json");
  await approve(failedBuild, failedPatch);
  await assert.rejects(() => runApply({ path: failedBuild }), /project restored/);
  assert.equal(await readFile(path.join(failedBuild, "source.js"), "utf8"), original);
  const failedMetadata = await readPatchMetadata(failedBuild);
  assert.equal(failedMetadata.patchStatus, "failed");

  for (const dir of [valid, missingApproval, invalid, failedBuild]) await rm(dir, { recursive: true, force: true });
  console.log("patch lifecycle verification passed: apply, approval gate, invalid patch, rollback/build failure");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
