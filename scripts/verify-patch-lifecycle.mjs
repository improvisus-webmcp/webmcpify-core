import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createPendingPatch, readPatchMetadata } from "../dist/lib/patches.js";
import { runApply } from "../dist/commands/apply.js";
import { withOperationSignal } from "../dist/lib/operation-context.js";
import { fixtureProvider } from "./fixture-provider.mjs";
import { executableOnPath } from "../dist/lib/executables.js";

const exec = promisify(execFile);
const git = (cwd, args) => exec("git", args, { cwd });
const original = "export const value = 'before';\n";
const fixtures = [];
const previousManager = process.env.WEBMCPIFY_PACKAGE_MANAGER;

async function fixture(buildScript, extraFiles = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "webmcpify-patch-"));
  fixtures.push(dir);
  await writeFile(path.join(dir, "source.js"), original);
  for (const [file, content] of Object.entries(extraFiles)) await writeFile(path.join(dir, file), content);
  const scripts = typeof buildScript === "object" ? buildScript : buildScript ? { build: buildScript } : {};
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts }));
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
    sourceDiff: { status: "approved", runId: metadata.runId, patchHash: metadata.patchHash },
  }));
}

async function main() {
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";

  const pnpm = executableOnPath("pnpm");
  if (pnpm) {
    const lockfile = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
    const nativePnpm = await fixture("node --check source.js", { "pnpm-lock.yaml": lockfile });
    await approve(nativePnpm, await createPendingPatch(nativePnpm, await makePatch(nativePnpm), "generation.json"));
    process.env.WEBMCPIFY_PACKAGE_MANAGER = pnpm;
    await runApply({ path: nativePnpm });
    assert.equal(await readFile(path.join(nativePnpm, "pnpm-lock.yaml"), "utf8"), lockfile, "Real pnpm validation must not trigger an install or rewrite the lockfile");
    process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
  }

  const valid = await fixture();
  const patch = await makePatch(valid);
  const metadata = await createPendingPatch(valid, patch, "generation.json", { securityPolicy: "balance" });
  assert.equal(metadata.securityPolicy, "balance");
  await approve(valid, metadata);
  await assert.rejects(runApply({ path: valid, expectedRunId: "another-reviewed-run" }), /changed after this workflow's review/);
  await assert.rejects(runApply({ path: valid, expectedPatchHash: "another-reviewed-patch" }), /changed after this workflow's review/);
  assert.equal(await readFile(path.join(valid, "source.js"), "utf8"), original);
  await runApply({ path: valid, expectedRunId: metadata.runId, expectedPatchHash: metadata.patchHash });
  assert.equal(await readFile(path.join(valid, "source.js"), "utf8"), "export const value = 'after';\n");
  await assert.rejects(readFile(path.join(valid, ".webmcpify/rollback", metadata.runId, "manifest.json")), { code: "ENOENT" }, "Successful apply removes its temporary source backups");

  const dependencyGuard = await fixture({ typecheck: "fixture-check", build: "fixture-check" }, { "dependency-sentinel": "installed dependencies unchanged\n" });
  const guardedManager = await fixtureProvider(valid, "guarded-package-manager", "if(process.env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN!=='false')process.exit(1);");
  process.env.WEBMCPIFY_PACKAGE_MANAGER = guardedManager;
  await approve(dependencyGuard, await createPendingPatch(dependencyGuard, await makePatch(dependencyGuard), "generation.json"));
  await runApply({ path: dependencyGuard });
  assert.equal(await readFile(path.join(dependencyGuard, "dependency-sentinel"), "utf8"), "installed dependencies unchanged\n", "Apply validation must not implicitly reinstall an installed dependency tree");
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";

  const tamperedDuringSnapshot = await fixture();
  const approvedBytes = await makePatch(tamperedDuringSnapshot);
  const snapshotPatch = await createPendingPatch(tamperedDuringSnapshot, approvedBytes, "generation.json");
  await approve(tamperedDuringSnapshot, snapshotPatch);
  const originalStderrWrite = process.stderr.write;
  let replaced = false;
  process.stderr.write = function (...args) {
    if (!replaced && String(args[0]).includes("Preparing rollback snapshot started")) {
      replaced = true;
      writeFileSync(snapshotPatch.patchPath, approvedBytes.replace("value = 'after'", "value = 'UNAPPROVED'"));
    }
    return originalStderrWrite.apply(this, args);
  };
  try { await runApply({ path: tamperedDuringSnapshot }); }
  finally { process.stderr.write = originalStderrWrite; }
  assert.equal(replaced, true, "Race fixture must replace pending bytes after hash validation");
  assert.equal(await readFile(path.join(tamperedDuringSnapshot, "source.js"), "utf8"), "export const value = 'after';\n", "Git must consume the exact validated bytes, not re-read a mutable pending patch path");

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

  const add = file => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+new content\n`;
  const multi = await fixture('node -e "require(\'node:fs\').writeFileSync(\'build-output.tmp\',\'side effect\');process.exit(1)"', { "obsolete.js": "old content\n", "old-name.js": "renamed content\n", "unrelated.txt": "untouched\n" });
  const multiDiff = await makePatch(multi)
    + "diff --git a/obsolete.js b/obsolete.js\ndeleted file mode 100644\n--- a/obsolete.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-old content\n"
    + "diff --git a/old-name.js b/new-name.js\nsimilarity index 100%\nrename from old-name.js\nrename to new-name.js\n"
    + add("created.js");
  const multiPatch = await createPendingPatch(multi, multiDiff, "generation.json");
  await approve(multi, multiPatch);
  await assert.rejects(runApply({ path: multi }), /project restored/);
  assert.equal(await readFile(path.join(multi, "source.js"), "utf8"), original);
  assert.equal(await readFile(path.join(multi, "obsolete.js"), "utf8"), "old content\n");
  assert.equal(await readFile(path.join(multi, "old-name.js"), "utf8"), "renamed content\n");
  for (const file of ["created.js", "new-name.js"]) await assert.rejects(readFile(path.join(multi, file)), { code: "ENOENT" });
  assert.equal(await readFile(path.join(multi, "unrelated.txt"), "utf8"), "untouched\n");
  assert.equal(await readFile(path.join(multi, "build-output.tmp"), "utf8"), "side effect", "Rollback covers patch paths, not arbitrary build side effects");
  const backupRoot = path.join(multi, ".webmcpify/rollback", multiPatch.runId);
  assert.deepEqual(new Set(JSON.parse(await readFile(path.join(backupRoot, "manifest.json"), "utf8"))), new Set(["source.js", "obsolete.js", "old-name.js"]));
  assert.equal(await readFile(path.join(backupRoot, "source.js"), "utf8"), original);

  const failedTypecheck = await fixture({ typecheck: 'node -e "process.exit(1)"', build: 'node -e "process.exit(0)"' });
  const typecheckPatch = await createPendingPatch(failedTypecheck, await makePatch(failedTypecheck), "generation.json");
  await approve(failedTypecheck, typecheckPatch);
  await assert.rejects(runApply({ path: failedTypecheck }), /project restored/);
  assert.equal(await readFile(path.join(failedTypecheck, "source.js"), "utf8"), original);

  const damaged = await fixture('node -e "const fs=require(\'node:fs\');const root=\'.webmcpify/rollback\';for(const run of fs.readdirSync(root))fs.rmSync(root+\'/\'+run+\'/source.js\');process.exit(1)"', { "other.js": "old other\n" });
  const damagedDiff = await makePatch(damaged) + "diff --git a/other.js b/other.js\n--- a/other.js\n+++ b/other.js\n@@ -1 +1 @@\n-old other\n+new other\n" + add("created.js");
  const damagedPatch = await createPendingPatch(damaged, damagedDiff, "generation.json");
  await approve(damaged, damagedPatch);
  await assert.rejects(runApply({ path: damaged }), /rollback failed/);
  assert.equal(await readFile(path.join(damaged, "source.js"), "utf8"), "export const value = 'after';\n", "A missing original backup must never cause deletion of the current source");
  assert.equal(await readFile(path.join(damaged, "other.js"), "utf8"), "old other\n", "Restore other recoverable files even when one backup is damaged");
  await assert.rejects(readFile(path.join(damaged, "created.js")), { code: "ENOENT" });
  assert.equal((await readPatchMetadata(damaged)).patchStatus, "failed");
  await readFile(path.join(damaged, ".webmcpify/rollback", damagedPatch.runId, "manifest.json"));

  const alteredManifest = await fixture('node -e "const fs=require(\'node:fs\');const root=\'.webmcpify/rollback\';for(const run of fs.readdirSync(root))fs.writeFileSync(root+\'/\'+run+\'/manifest.json\',\'[]\');process.exit(1)"');
  const alteredPatch = await createPendingPatch(alteredManifest, await makePatch(alteredManifest) + add("created.js"), "generation.json");
  await approve(alteredManifest, alteredPatch);
  await assert.rejects(runApply({ path: alteredManifest }), /project restored/);
  assert.equal(await readFile(path.join(alteredManifest, "source.js"), "utf8"), original, "A damaged manifest cannot classify an original as a new file and delete it");
  await assert.rejects(readFile(path.join(alteredManifest, "created.js")), { code: "ENOENT" });

  const cancelled = await fixture('node owned-build.cjs', {
    "owned-build.cjs": "require('node:child_process').spawn(process.execPath,['child-build.cjs'],{stdio:'ignore'});setInterval(()=>{},1000);\n",
    "child-build.cjs": "require('node:fs').writeFileSync('build-started.flag','yes');setTimeout(()=>require('node:fs').writeFileSync('source.js','LATE CHILD CORRUPTION'),1200);\n",
  });
  const cancelledPatch = await createPendingPatch(cancelled, await makePatch(cancelled), "generation.json");
  await approve(cancelled, cancelledPatch);
  const controller = new AbortController();
  const applying = withOperationSignal(controller.signal, () => runApply({ path: cancelled }));
  applying.catch(() => {});
  try {
    let started = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { await readFile(path.join(cancelled, "build-started.flag")); started = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(started, true, "Cancellation fixture must reach the applied patch's build");
    controller.abort();
    await assert.rejects(applying, /project restored/);
    assert.equal(await readFile(path.join(cancelled, "source.js"), "utf8"), original);
    assert.equal((await readPatchMetadata(cancelled)).patchStatus, "failed");
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(await readFile(path.join(cancelled, "source.js"), "utf8"), original, "Owned build children must stop before rollback, not overwrite restored source later");
  } finally { controller.abort(); await applying.catch(() => {}); }
  console.log("patch lifecycle verification passed: exact validated-byte apply, approval/tampering-race gates, build/typecheck/cancellation rollback, added/deleted/renamed files, and damaged-backup safety");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const dir of fixtures) await rm(dir, { recursive: true, force: true });
  if (previousManager === undefined) delete process.env.WEBMCPIFY_PACKAGE_MANAGER;
  else process.env.WEBMCPIFY_PACKAGE_MANAGER = previousManager;
});
