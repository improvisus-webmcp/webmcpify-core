import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "webmcpify-optional-temporal-"),
);
const packageRoot = path.join(temporaryRoot, "package");
const fixtureRoot = path.join(temporaryRoot, "fixture");

function runNode(args, input) {
  return spawnSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: "utf8",
    input,
    env: { ...process.env, WEBMCPIFY_DURABLE: "false" },
  });
}

function assertSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

try {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );

  await mkdir(packageRoot, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  await cp(path.join(repositoryRoot, "dist"), path.join(packageRoot, "dist"), {
    recursive: true,
  });
  await copyFile(
    path.join(repositoryRoot, "package.json"),
    path.join(packageRoot, "package.json"),
  );
  await writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({ name: "optional-temporal-fixture", private: true }),
  );
  await writeFile(
    path.join(fixtureRoot, "index.html"),
    '<form><input name="query"><button type="submit">Search</button></form>',
  );

  // Recreate a production install with only Core's regular runtime dependencies.
  // Their real package locations retain their own transitive dependency trees,
  // while the isolated package has no @temporalio namespace at all.
  for (const dependency of Object.keys(manifest.dependencies)) {
    const source = await realpath(
      path.join(repositoryRoot, "node_modules", dependency),
    );
    const destination = path.join(packageRoot, "node_modules", dependency);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
  }

  for (const temporalPackage of ["client", "worker", "workflow"]) {
    await assert.rejects(
      access(
        path.join(
          packageRoot,
          "node_modules",
          "@temporalio",
          temporalPackage,
        ),
      ),
      undefined,
      `isolated package unexpectedly contains @temporalio/${temporalPackage}`,
    );
  }

  const version = runNode(["dist/cli.js", "--version"]);
  assertSucceeded(version, "normal CLI startup");
  assert.equal(version.stdout.trim(), manifest.version, JSON.stringify({ status: version.status, stdout: version.stdout, stderr: version.stderr }));

  const discovery = runNode([
    "dist/cli.js",
    "discover",
    "--path",
    fixtureRoot,
  ]);
  assertSucceeded(discovery, "normal CLI command");

  for (const args of [[], ["--no-durable"]]) {
    const normalRun = runNode(["dist/cli.js", "run", "--path", fixtureRoot, "--url", "http://127.0.0.1:1", ...args]);
    assert.equal(normalRun.status, 1, "A normal run must reach its URL check without optional SDKs");
    assert.match(normalRun.stderr, /not reachable/);
    assert.doesNotMatch(normalRun.stderr, /Temporal support is optional|@temporalio/);
  }

  const initializeRequest = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "optional-temporal-test", version: "1" },
    },
  })}\n`;
  const mcp = runNode(["dist/mcp/server.js"], initializeRequest);
  assertSucceeded(mcp, "normal MCP startup");
  const initialized = JSON.parse(mcp.stdout.trim());
  assert.equal(initialized.result.serverInfo.name, "webmcpify-core");

  const repairModule = pathToFileURL(
    path.join(packageRoot, "dist", "commands", "repair.js"),
  ).href;
  const durableRepair = runNode([
    "--input-type=module",
    "--eval",
    `const { runRepair } = await import(${JSON.stringify(repairModule)}); await runRepair({ durable: true, path: process.argv[1], url: "http://127.0.0.1:1", task: "fixture-task" });`,
    fixtureRoot,
  ]);
  assert.notEqual(durableRepair.status, 0);
  assert.match(
    durableRepair.stderr,
    /Temporal support is optional\. Install it before using durable workflows: npm install @temporalio\/client @temporalio\/worker @temporalio\/workflow/,
  );

  const worker = runNode(["dist/temporal/worker.js"]);
  assert.notEqual(worker.status, 0);
  assert.match(
    worker.stderr,
    /Temporal support is optional\..*npm install @temporalio\/client @temporalio\/worker @temporalio\/workflow/,
  );

  for (const args of [["--help"], ["--durable", "--url", "http://127.0.0.1:1"], ["--resume", "fixture-workflow"]]) {
    const result = runNode(["dist/cli.js", "run", "--path", fixtureRoot, ...args]);
    if (args[0] === "--help") assertSucceeded(result, "normal run help without optional peers");
    else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Temporal support is optional\..*npm install @temporalio\/client @temporalio\/worker @temporalio\/workflow/);
    }
  }

  console.log(
    "Optional Temporal verification passed: normal CLI/MCP paths run without peers and Temporal entry points explain how to install them",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
