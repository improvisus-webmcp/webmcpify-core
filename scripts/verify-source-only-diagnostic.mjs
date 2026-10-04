import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { runGenerate } from "../dist/commands/generate.js";
import { fixtureProvider } from "./fixture-provider.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-source-only-check-"));
const originalEnv = { ...process.env };
const originals = [console.log, console.warn, console.error];
const logs = [];
const source = "export function selectItem() { return true; }\n";
try {
  const provider = await fixtureProvider(root, "provider", `
import {readFileSync, writeFileSync} from 'node:fs';
const args = process.argv.slice(2);
if(args.includes('--output-schema') || !args.at(-1).includes('source-edit-only diagnostic')) process.exit(8);
const counter = process.env.FIXTURE_SOURCE_ONLY_COUNTER;
writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1));
if(process.env.FIXTURE_SOURCE_ONLY_MODE === 'failed') { process.stderr.write('PRIVATE_PROVIDER_OUTPUT'); process.exit(7); }
if(process.env.FIXTURE_SOURCE_ONLY_MODE !== 'empty') writeFileSync('src/app.js', readFileSync('src/app.js', 'utf8') + '// diagnostic edit\\n');
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Source edits completed.'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`);
  process.env.WEBMCPIFY_CODEX_BIN = provider;
  console.log = console.warn = console.error = (...args) => logs.push(args.map(String).join(" "));
  for (const mode of ["edited", "empty", "failed"]) {
    const site = path.join(root, mode);
    await mkdir(path.join(site, "src"), { recursive: true });
    await mkdir(path.join(site, ".webmcpify"));
    await writeFile(path.join(site, "src/app.js"), source);
    await writeFile(path.join(site, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.exit(97)\"" } }));
    await writeFile(path.join(site, ".gitignore"), ".webmcpify/\n");
    const preserved = ["approved-tools.json", "proposed-tools.json", "security-report.json", "pending-diff.patch", "pending-diff.meta.json", "discovery.json"];
    for (const file of preserved) await writeFile(path.join(site, ".webmcpify", file), "existing state\n");
    await writeFile(path.join(site, "tasks.json"), "existing tasks\n");
    for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-qm", "baseline"]]) await execa("git", args, { cwd: site });
    process.env.FIXTURE_SOURCE_ONLY_MODE = mode;
    process.env.FIXTURE_SOURCE_ONLY_COUNTER = path.join(root, `${mode}-counter`);
    await writeFile(process.env.FIXTURE_SOURCE_ONLY_COUNTER, "0");
    const run = () => runGenerate({ path: site, provider: "codex", diagnosticSourceOnly: true, productContextPrompt: false });
    if (mode === "edited") await run();
    else await assert.rejects(run(), mode === "empty" ? /returned without source edits/ : /codex.*failed/i);
    assert.equal(await readFile(path.join(site, "src/app.js"), "utf8"), source);
    for (const file of preserved) assert.equal(await readFile(path.join(site, ".webmcpify", file), "utf8"), "existing state\n");
    assert.equal(await readFile(path.join(site, "tasks.json"), "utf8"), "existing tasks\n");
    assert.equal(await readFile(process.env.FIXTURE_SOURCE_ONLY_COUNTER, "utf8"), "1", "Only one provider invocation; no correction or edit retry");
    const artifacts = await readdir(path.join(site, ".webmcpify/trajectories"));
    const diffs = artifacts.filter(file => /^generate-source-only-diff-.*\.json$/.test(file) && !file.endsWith(".meta.json"));
    assert.equal(diffs.length, mode === "edited" ? 1 : 0);
    if (diffs.length) {
      const metadata = JSON.parse(await readFile(path.join(site, ".webmcpify/trajectories", diffs[0].replace(/\.json$/, ".meta.json")), "utf8"));
      assert.equal(metadata.unvalidated, true);
      assert.equal(metadata.diagnosticSourceOnly, true);
    }
  }
  assert.doesNotMatch(logs.join("\n"), /PRIVATE_PROVIDER_OUTPUT|diagnostic edit|metadata validation START|capability accounting START|target preflight build START|security audit START|awaiting review/);
} finally {
  [console.log, console.warn, console.error] = originals;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(root, { recursive: true, force: true });
}
console.log("Source-only diagnostic passed: no schema, one provider call, no validation/review/apply, preserved target source and existing state, private unvalidated diff.");
