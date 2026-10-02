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
  await mkdir(path.join(fixture, "src"));
  const actions = ["addToCart", "removeFromCart", "updateCartQuantity", "checkout", "login", "logout", "clearNotice"];
  await writeFile(path.join(fixture, "src/store.ts"), `const set = (value: unknown) => value;
export const store = {${actions.map(action => `${action}: () => set({action: '${action}'})`).join(",")}};`);
  await writeFile(path.join(fixture, "src/App.tsx"), `import {store} from './store';
const {login, logout, removeFromCart, updateCartQuantity} = store;
export function App() {return <main><button onClick={true ? logout : login}>Session</button>
<button onClick={() => {
  if (true) removeFromCart();
  else updateCartQuantity();
}}>Quantity</button>${Array.from({length: 310}, () => '\n<button onClick={login}>Login</button>').join('')}</main>;}`);
  await writeFile(path.join(fixture, "src/broken.ts"), "const invalid: = <button onClick={login}>\n");
  const expanded = await discoverProject(fixture);
  const candidates = expanded.actionCandidates;
  assert.deepEqual(candidates.filter(candidate => candidate.file === "src/store.ts" && candidate.resolved).map(candidate => candidate.handler).sort(), [...actions].sort());
  for (const handler of ["login", "logout", "removeFromCart", "updateCartQuantity"]) assert.ok(candidates.some(candidate => candidate.file === "src/App.tsx" && candidate.handler === handler), `Conditional/multiline action ${handler} must survive discovery`);
  assert.ok(expanded.actions.length > 300, "Discovery must not silently truncate action signals");
  assert.ok(expanded.buttons.length > 300, "Discovery must not silently truncate UI signals");
  assert.match(expanded.discoveryWarnings.join("\n"), /src\/broken.ts/);
  assert.deepEqual((await discoverProject(fixture)).actionCandidates, candidates, "Inventory IDs and ordering must be repeatable");
  console.log("Self-contained discovery verification passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
