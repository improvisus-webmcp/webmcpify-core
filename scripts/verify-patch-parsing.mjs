import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractUnifiedDiff } from "../dist/lib/patches.js";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-parser-test-"));
const exec = promisify(childProcess.execFile);
const git = args => exec("git", args, { cwd: root, timeout: 30_000 });
const spawn = childProcess.spawnSync;
const execFile = childProcess.execFile;
try {
  await git(["init", "-q"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Parser fixture"]);
  await writeFile(path.join(root, "source.js"), "export const value = 1;  \n");
  await writeFile(path.join(root, "asset.bin"), Buffer.alloc(100_000, 0));
  await git(["add", "-A"]);
  await git(["-c", "commit.gpgsign=false", "commit", "-qm", "baseline"]);
  await writeFile(path.join(root, "source.js"), "export const value = 2;  \n" + "// preserve trailing space  \n".repeat(10_000));
  await writeFile(path.join(root, "asset.bin"), Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 256)));
  const { stdout: patch } = await git(["diff", "--binary", "--no-ext-diff", "--no-textconv"]);
  assert.ok(patch.length > 64_000, "Exercise a patch larger than a typical stdin pipe buffer");
  assert.match(patch, /GIT binary patch/);
  for (let attempt = 0; attempt < 3; attempt++) {
    const parsed = extractUnifiedDiff(patch);
    assert.equal(parsed.patch, patch, "Valid text/binary patch bytes must remain exact");
    assert.deepEqual(parsed.changedFiles.sort(), ["asset.bin", "source.js"]);
  }

  let temporaryFile;
  childProcess.spawnSync = (command, args, options) => {
    assert.equal(command, "git");
    assert.deepEqual(args.slice(0, 3), ["apply", "--numstat", "-z"]);
    assert.equal(options.input, undefined, "Patch parsing must not depend on synchronous stdin piping");
    assert.equal(options.stdio[0], "ignore");
    assert.equal(options.timeout, 30_000);
    assert.equal(options.killSignal, "SIGKILL");
    temporaryFile = args[3];
    assert.equal(readFileSync(temporaryFile, "utf8"), patch);
    return { status: null, error: Object.assign(new Error("private Git diagnostic"), { code: "ETIMEDOUT" }) };
  };
  syncBuiltinESMExports();
  assert.throws(() => extractUnifiedDiff(patch), error => {
    assert.match(error.message, /Git patch inspection timed out/);
    assert.doesNotMatch(error.message, /private Git diagnostic/);
    return true;
  });
  assert.equal(existsSync(path.dirname(temporaryFile)), false, "Timeouts must remove private patch files");

  childProcess.execFile = (_command, _args, options, callback) => {
    assert.equal(options.timeout, 30_000);
    assert.equal(options.killSignal, "SIGKILL");
    process.nextTick(() => callback(Object.assign(new Error("private timeout output"), { killed: true })));
  };
  syncBuiltinESMExports();
  // A fresh module binds promisify to the timeout fixture, not the real Git.
  const { gitSourceSnapshot } = await import("../dist/lib/patches.js?timeout-fixture");
  await assert.rejects(gitSourceSnapshot(root), /Git source-identity inspection timed out/,
    "A timed-out initial identity check must not silently return an empty identity");
} finally {
  childProcess.spawnSync = spawn;
  childProcess.execFile = execFile;
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
console.log("Patch parsing passed: repeated large text/binary patches, exact bytes, bounded Git execution and private-file cleanup");
