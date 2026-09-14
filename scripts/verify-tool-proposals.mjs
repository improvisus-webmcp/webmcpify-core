import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverProject } from "../dist/lib/discovery.js";
import {
  extractAndValidateProposedTools,
  writeProposedTools,
} from "../dist/lib/tool-proposals.js";

const fixture = await mkdtemp(path.join(os.tmpdir(), "webmcpify-tools-"));

try {
  await mkdir(path.join(fixture, "src"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "tool-proposal-fixture" }),
  );
  await writeFile(
    path.join(fixture, "src", "search.tsx"),
    `export function Search() {
  return <form onSubmit={() => undefined}><input name="query" /><button type="submit">Search</button></form>;
}\n`,
  );

  const discovery = await discoverProject(fixture);
  const file = discovery.actions[0]?.file ?? discovery.forms[0]?.file;
  assert.ok(file, "fixture has no actionable discovery signal");
  const tool = {
    id: "discovered_action",
    name: "discovered_action",
    description: "Runs a discovered action.",
    title: "Discovered action",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      untrustedContentHint: false,
      consequentialHint: true,
    },
    security: {
      userAuthentication: "required",
      agentIdentity: "required",
      authorization: "backend",
      originScope: "same-origin",
      rateLimit: { enforced: true, scope: "agent-user-tool", limit: 3, windowSeconds: 86400 },
      idempotency: { enforced: true, keyParameter: "idempotencyKey" },
      notes: "Backend enforcement is part of the reviewed proposal.",
    },
    implementation: {
      handler: `${file}#handler`,
      action: "discovered action",
    },
    placement: {
      strategy: "imperative",
      file,
      rationale: "Uses the discovered action location.",
    },
    sourceFiles: [file],
  };

  const validTools = extractAndValidateProposedTools(
    JSON.stringify({ tools: [tool] }),
    discovery,
  );
  assert.equal(validTools.length, 1);
  const proposalPath = await writeProposedTools(
    fixture,
    validTools,
    "discovery.json",
    "generation.json",
  );
  assert.equal(JSON.parse(await readFile(proposalPath, "utf8")).tools.length, 1);
  assert.throws(
    () =>
      extractAndValidateProposedTools(
        JSON.stringify({ tools: [tool, { ...tool, id: "other_action" }] }),
        discovery,
      ),
    /Duplicate tool name/,
  );
  assert.throws(
    () =>
      extractAndValidateProposedTools(
        JSON.stringify({
          tools: [
            {
              ...tool,
              sourceFiles: ["missing.ts"],
              placement: { ...tool.placement, file: "missing.ts" },
            },
          ],
        }),
        discovery,
      ),
    /no source file/,
  );
  assert.throws(
    () =>
      extractAndValidateProposedTools(
        JSON.stringify({
          tools: [
            { ...tool, id: "bad", name: "bad", parameters: undefined },
          ],
        }),
        discovery,
      ),
    /parameters/,
  );
  console.log("Self-contained structured proposal verification passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
