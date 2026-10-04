import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GENERATE_ONLY_PROMPT } from "../dist/commands/generate.js";
import { GENERATION_EXECUTION_GUIDANCE, TOOL_PLACEMENT_GUIDANCE } from "../dist/lib/prompts.js";
import { runGenerationPreflight, PreflightEnvironmentError, GenerationPreflightError } from "../dist/lib/preflight.js";

assert.ok(GENERATE_ONLY_PROMPT.includes(GENERATION_EXECUTION_GUIDANCE));
assert.ok(GENERATE_ONLY_PROMPT.length < 4000, 'Source instructions must remain compact');
assert.doesNotMatch(GENERATE_ONLY_PROMPT, /TOOL_PROPOSALS_JSON|TASKS_JSON|CAPABILITY_COVERAGE_JSON/, 'Source pass must not author metadata');
assert.match(GENERATION_EXECUTION_GUIDANCE, /Do not install, update, or download/);
assert.match(GENERATION_EXECUTION_GUIDANCE, /Core runs the target's checks afterward/);
assert.doesNotMatch(GENERATE_ONLY_PROMPT, /Run the\s+(?:workspace|site's) typecheck/);
assert.doesNotMatch(TOOL_PLACEMENT_GUIDANCE, /Run the site's typecheck/);
for (const file of ["src/commands/generate.ts", "src/lib/capability-coverage.ts"]) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  assert.ok(source.includes("${GENERATION_EXECUTION_GUIDANCE}"));
  if (file.endsWith("generate.ts")) {
    assert.equal((source.match(/\$\{GENERATION_EXECUTION_GUIDANCE\}/g) ?? []).length, 3,
      "Initial generation, source repair and edit retry must all leave checks to Core");
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-generation-dependencies-"));
const originalManager = process.env.WEBMCPIFY_PACKAGE_MANAGER;
const originalLog = console.log;
const logs = [];
console.log = (...args) => logs.push(args.map(String).join(" "));
async function fixture(name, manifest) {
  const site = path.join(root, name, "target");
  const workspace = path.join(root, name, "workspace");
  await mkdir(site, { recursive: true });
  await mkdir(workspace, { recursive: true });
  if (manifest) {
    const text = JSON.stringify(manifest);
    await writeFile(path.join(site, "package.json"), text);
    await writeFile(path.join(workspace, "package.json"), text);
  }
  return { site, workspace };
}
try {
  // With no declared check, even a missing package manager is irrelevant.
  process.env.WEBMCPIFY_PACKAGE_MANAGER = path.join(root, "missing-manager");
  const plain = await fixture("plain");
  await runGenerationPreflight(plain.site, plain.workspace);

  const missing = await fixture("missing", { dependencies: { fixture: "1.0.0" }, scripts: { build: "node --check app.js" } });
  await assert.rejects(runGenerationPreflight(missing.site, missing.workspace), error =>
    error instanceof PreflightEnvironmentError && /dependencies are not installed/.test(error.message));

  const missingTs = await fixture("missing-ts-dependencies", { devDependencies: { typescript: "1.0.0" } });
  await writeFile(path.join(missingTs.site, "tsconfig.json"), "{}");
  await assert.rejects(runGenerationPreflight(missingTs.site, missingTs.workspace), error =>
    error instanceof PreflightEnvironmentError && /dependencies are not installed/.test(error.message));

  const missingCompiler = await fixture("missing-compiler", {});
  await mkdir(path.join(missingCompiler.site, "node_modules"));
  await writeFile(path.join(missingCompiler.site, "tsconfig.json"), "{}");
  await assert.rejects(runGenerationPreflight(missingCompiler.site, missingCompiler.workspace), error =>
    error instanceof PreflightEnvironmentError && /local TypeScript compiler is missing/.test(error.message));

  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
  const pureJs = await fixture("pure-js", { scripts: { build: "node --check app.js" } });
  await writeFile(path.join(pureJs.workspace, "app.js"), "const value = 1;\n");
  await runGenerationPreflight(pureJs.site, pureJs.workspace);
  await writeFile(path.join(pureJs.workspace, "app.js"), "const = ;\n");
  await assert.rejects(runGenerationPreflight(pureJs.site, pureJs.workspace), GenerationPreflightError);

  const installed = await fixture("installed", { dependencies: { "fixture-dependency": "1.0.0" }, scripts: { build: "node check.cjs" } });
  const dependency = path.join(installed.site, "node_modules", "fixture-dependency");
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, "index.js"), "module.exports = 42;\n");
  await writeFile(path.join(installed.workspace, "check.cjs"), `
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(require('fixture-dependency'), 42);
assert.equal(process.env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN, 'false');
fs.mkdirSync('node_modules/.cache', {recursive:true});
fs.writeFileSync('node_modules/.cache/check-result', 'passed');
`);
  await runGenerationPreflight(installed.site, installed.workspace);
  assert.equal(await readFile(path.join(dependency, "index.js"), "utf8"), "module.exports = 42;\n");
  await assert.rejects(readFile(path.join(installed.site, "node_modules/.cache/check-result")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(installed.workspace, "node_modules/.cache/check-result"), "utf8"), "passed");
} finally {
  console.log = originalLog;
  if (originalManager === undefined) delete process.env.WEBMCPIFY_PACKAGE_MANAGER;
  else process.env.WEBMCPIFY_PACKAGE_MANAGER = originalManager;
  await rm(root, { recursive: true, force: true });
}
assert.ok(logs.some(line => /preflight skipped/.test(line)));
assert.ok(logs.some(line => /preflight build passed/.test(line)));
console.log("Generation dependency checks passed: source-only prompts, plain JS, installed dependency reuse, isolated caches, missing dependencies/compiler and real build failures.");
