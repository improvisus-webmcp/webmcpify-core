import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAgentWorkspace, initializeAgentWorkspace, readAgentWorkspaceDiff, removeAgentWorkspace } from "../dist/lib/agent-workspace.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "webmcpify-copy-"));
const source = path.join(root, "source");
const git = args => promisify(execFile)("git", args, { cwd: source });
const originalCp = fs.cp;
const workspaces = [];
try {
  await fs.mkdir(source);
  await fs.mkdir(path.join(source, "src"));
  await fs.writeFile(path.join(source, "src/app.js"), "export const value = 'committed';\n");
  await fs.writeFile(path.join(source, "src/staged.js"), "export const stage = 'committed';\n");
  await fs.writeFile(path.join(source, ".gitignore"), "required-local.json\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Copy fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-qm", "baseline"]]) await git(args);
  await fs.writeFile(path.join(source, "src/app.js"), "export const value = 'saved dirty edit';\n");
  await fs.writeFile(path.join(source, "src/staged.js"), "export const stage = 'saved staged edit';\n");
  await git(["add", "src/staged.js"]);
  await fs.writeFile(path.join(source, "src/New Component café.jsx"), "export const untracked = true;\n");
  await fs.writeFile(path.join(source, "required-local.json"), '{"neededForBuild":true}\n');
  await fs.mkdir(path.join(source, "assets"));
  await fs.writeFile(path.join(source, "assets/data.bin"), Buffer.alloc(1024 * 1024, 0x7b));
  await fs.mkdir(path.join(source, "node_modules-helper"));
  await fs.writeFile(path.join(source, "node_modules-helper/required.js"), "export const keep = true;\n");
  for (const name of [".webmcpify", ".serena", "node_modules", "nested/.webmcpify", "nested/.serena", "nested/node_modules", "nested/.git"]) {
    await fs.mkdir(path.join(source, name), {recursive:true});
    await fs.writeFile(path.join(source, name, "omitted.txt"), "temporary fixture data\n");
  }
  const contents = new Map();
  for (const file of [".gitignore", "src/app.js", "src/staged.js", "src/New Component café.jsx", "required-local.json", "assets/data.bin", "node_modules-helper/required.js"]) contents.set(file, await fs.readFile(path.join(source, file)));
  const beforeStatus = (await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  const beforeHead = (await git(["rev-parse", "HEAD"])).stdout;
  for (const ordinaryCopy of [false, true]) {
    let copyCalls = 0;
    let destination;
    fs.cp = async (from, to, options) => {
      copyCalls++;
      destination = to;
      assert.equal(options.mode, constants.COPYFILE_FICLONE, "Workspace copying must request optional copy-on-write, never a hard link or forced clone");
      assert.equal(options.recursive, true);
      // Force ordinary copying for this fixture independently of filesystem
      // support. Node's optional FICLONE fallback has the same copy semantics.
      return originalCp(from, to, ordinaryCopy ? {...options, mode:0} : options);
    };
    syncBuiltinESMExports();
    const workspace = await createAgentWorkspace(source);
    workspaces.push(workspace);
    assert.equal(copyCalls, 1);
    assert.equal(workspace, destination);
    for (const [file, content] of contents) assert.deepEqual(await fs.readFile(path.join(workspace, file)), content, `${file} must survive ${ordinaryCopy?'ordinary':'optional reflink'} copying byte-for-byte`);
    for (const name of [".git", ".webmcpify", ".serena", "node_modules", "nested/.webmcpify", "nested/.serena", "nested/node_modules", "nested/.git"]) await assert.rejects(fs.access(path.join(workspace, name)), {code:"ENOENT"});
    await initializeAgentWorkspace(workspace);
    assert.equal(await readAgentWorkspaceDiff(workspace), "", "Saved dirty/untracked files belong to the baseline, not a proposed patch");
    await fs.writeFile(path.join(workspace, "src/app.js"), "export const value = 'agent edit';\n");
    await fs.writeFile(path.join(workspace, "assets/data.bin"), Buffer.from([0,1,2,3]));
    await fs.writeFile(path.join(workspace, "src/New Component café.jsx"), "export const untracked = false;\n");
    await fs.rm(path.join(workspace, "src/staged.js"));
    for (const [file, content] of contents) assert.deepEqual(await fs.readFile(path.join(source, file)), content, "Editing/deleting copied files must never modify source files");
    assert.match(await readAgentWorkspaceDiff(workspace), /agent edit/);
    await removeAgentWorkspace(workspace);
    await assert.rejects(fs.access(workspace), {code:"ENOENT"});
  }
  fs.cp = async (_from, to) => {
    workspaces.push(to);
    await fs.writeFile(path.join(to, "partial.txt"), "partly copied fixture\n");
    throw Object.assign(new Error("Fixture permission failure"), {code:"EACCES"});
  };
  syncBuiltinESMExports();
  await assert.rejects(createAgentWorkspace(source), {code:"EACCES"});
  await assert.rejects(fs.access(workspaces.at(-1)), {code:"ENOENT"}, "Failed copies must clean up their disposable directory");
  assert.equal((await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout, beforeStatus, "Target Git status must remain unchanged");
  assert.equal((await git(["rev-parse", "HEAD"])).stdout, beforeHead, "Target Git history must remain unchanged");
} finally {
  fs.cp = originalCp;
  syncBuiltinESMExports();
  for (const workspace of workspaces) await removeAgentWorkspace(workspace);
  await fs.rm(root, {recursive:true, force:true});
}
console.log("Workspace copy passed: optional reflink and ordinary-copy paths, saved dirty/staged/untracked/ignored-required files, binary assets, nested exclusions, edit/delete isolation, unchanged target Git, and failure cleanup");
