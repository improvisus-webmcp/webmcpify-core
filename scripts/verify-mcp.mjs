import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const fixture = await mkdtemp(path.join(process.cwd(), ".tmp-mcp-"));
const packageVersion = JSON.parse(await readFile("package.json", "utf8")).version;
await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "mcp-fixture", scripts: { build: "echo ok" } }));
await writeFile(path.join(fixture, "index.html"), '<form><input name="query"><button type="submit">Search</button></form>');

try {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "verify", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "analyze_repository", arguments: { repositoryPath: fixture } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "analyze_repository", arguments: { repositoryPath: "../" } } },
  ];
  const { handle } = await import("../dist/mcp/server.js");
  const replies = (await Promise.all(requests.map(async (request) => JSON.parse(await handle(request)))));
  const initialized = replies.find((reply) => reply.id === 1);
  assert.equal(initialized.result.serverInfo.name, "webmcpify-core");
  assert.equal(initialized.result.serverInfo.version, packageVersion);
  const listed = replies.find((reply) => reply.id === 2);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["analyze_repository", "generate_webmcp", "apply_webmcp", "test_webmcp"]);
  const analyzed = replies.find((reply) => reply.id === 3);
  assert.equal(analyzed.result.structuredContent.project.name, "mcp-fixture");
  assert.ok(analyzed.result.structuredContent.capabilities.includes("forms"));
  const rejected = replies.find((reply) => reply.id === 4);
  assert.equal(rejected.result.isError, true);
  console.log("MCP end-to-end verification passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
