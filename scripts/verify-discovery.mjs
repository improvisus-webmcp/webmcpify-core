import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverProject,
  discoveryPath,
  runDiscovery,
} from "../dist/lib/discovery.js";

const fixture = await mkdtemp(path.join(os.tmpdir(), "webmcpify-discovery-"));

try {
  await mkdir(path.join(fixture, "app", "api", "products"), {
    recursive: true,
  });
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "discovery-fixture",
      dependencies: { next: "15.0.0", react: "19.0.0" },
      scripts: { dev: "next dev", build: "next build" },
    }),
  );
  await writeFile(
    path.join(fixture, "app", "page.tsx"),
    `export default function Page() {
  return <form><input name="query" /><button type="submit">Search</button></form>;
}\n`,
  );
  await writeFile(
    path.join(fixture, "app", "api", "products", "route.ts"),
    `export async function GET() { return Response.json({ products: [] }); }\n`,
  );

  await runDiscovery(fixture);
  const stored = JSON.parse(await readFile(discoveryPath(fixture), "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.targetProject, fixture);
  assert.deepEqual(stored.stack.language, ["TypeScript", "JavaScript"]);
  assert.equal(stored.stack.framework, "Next.js");
  assert.ok(stored.routes.includes("/"));
  assert.ok(stored.forms.length > 0);
  assert.ok(stored.buttons.length > 0);
  assert.ok(stored.apis.length > 0);
  assert.ok(stored.filesScanned > 0);

  const fresh = await discoverProject(fixture);
  assert.equal(fresh.stack.framework, stored.stack.framework);
  assert.equal(fresh.filesScanned, stored.filesScanned);
  console.log("Self-contained discovery verification passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
