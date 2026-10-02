import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverProject } from "../dist/lib/discovery.js";
import { auditToolSecurity, resolveSecurityPolicy } from "../dist/lib/security-audit.js";
import { validateProposedTools } from "../dist/lib/tool-proposals.js";
import { runSecurity } from "../dist/commands/security.js";

const fixture = await mkdtemp(path.join(os.tmpdir(), "webmcpify-security-"));
try {
  assert.equal(resolveSecurityPolicy(), "balance");
  assert.equal(resolveSecurityPolicy("strict"), "strict");
  await mkdir(path.join(fixture, "src"));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "security-fixture" }));
  await writeFile(path.join(fixture, "src", "checkout.tsx"), `export async function checkout() { return fetch('/api/orders', { method: 'POST' }); }\nexport function Form(){return <form onSubmit={checkout}><button>Order</button></form>}\n`);
  const discovery = await discoverProject(fixture);
  const file = discovery.actions[0]?.file ?? discovery.forms[0]?.file;
  assert.ok(file);
  const base = {
    id: "place_order",
    name: "place_order",
    title: "Place order",
    description: "Places the reviewed order once.",
    parameters: { type: "object", properties: { idempotencyKey: { type: "string", maxLength: 80 } }, required: ["idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false, consequentialHint: true },
    security: {
      userAuthentication: "required",
      agentIdentity: "required",
      authorization: "backend",
      originScope: "same-origin",
      rateLimit: { enforced: true, scope: "agent-user-tool", limit: 3, windowSeconds: 86400 },
      idempotency: { enforced: true, keyParameter: "idempotencyKey" },
      notes: "The proposed backend order handler verifies the user and agent before persisting once.",
    },
    implementation: { handler: `${file}#checkout`, action: "place order" },
    behavior: { success: "The order is placed.", preconditions: [], expectedFailures: [] },
    placement: { strategy: "imperative", file, rationale: "Uses the discovered checkout action." },
    sourceFiles: [file],
  };
  const [secure] = validateProposedTools({ tools: [base] }, discovery);
  const secureReport = auditToolSecurity([secure], discovery, fixture);
  assert.equal(secureReport.summary.block, 0);

  const [missing] = validateProposedTools({ tools: [{ ...base, security: undefined }] }, discovery);
  assert.equal(auditToolSecurity([missing], discovery, fixture).status, "block");

  const [anonymous] = validateProposedTools({ tools: [{ ...base, security: { ...base.security, agentIdentity: "none", rateLimit: { ...base.security.rateLimit, enforced: false }, idempotency: { enforced: false } } }] }, discovery);
  const blocked = auditToolSecurity([anonymous], discovery, fixture);
  assert.ok(blocked.findings.some((item) => item.code === "agent-binding-missing"));
  assert.ok(blocked.findings.some((item) => item.code === "quota-missing"));
  assert.ok(blocked.findings.some((item) => item.code === "replay-protection-missing"));

  const [cart] = validateProposedTools({ tools: [{
    ...base,
    id: "add_to_cart",
    name: "add_to_cart",
    title: "Add to cart",
    description: "Adds a coffee to the local cart before purchase.",
    parameters: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"], additionalProperties: false },
    security: { ...base.security, userAuthentication: "none", agentIdentity: "none", authorization: "client-only", rateLimit: { ...base.security.rateLimit, enforced: false }, idempotency: { enforced: false } },
    implementation: { ...base.implementation, action: "add item to cart" },
  }] }, discovery);
  const strictCart = auditToolSecurity([cart], discovery, fixture, "strict");
  assert.equal(strictCart.status, "review");
  assert.equal(strictCart.summary.block, 0);
  assert.ok(!strictCart.findings.some((item) => /backend|binding|quota|replay/.test(item.code)));
  assert.ok(strictCart.findings.some((item) => item.code === "string-unbounded"));
  const balancedCart = auditToolSecurity([cart], discovery, fixture, "balance");
  assert.equal(balancedCart.policy, "balance");
  assert.equal(balancedCart.status, "pass");
  assert.equal(balancedCart.findings.length, 0);
  const defaultCart = auditToolSecurity([cart], discovery, fixture);
  assert.equal(defaultCart.policy, "balance", "The default audit must use balanced policy");
  assert.equal(defaultCart.status, "pass");
  assert.deepEqual(defaultCart.findings, balancedCart.findings);
  await mkdir(path.join(fixture, ".webmcpify"), { recursive: true });
  await writeFile(path.join(fixture, ".webmcpify/discovery.json"), JSON.stringify(discovery));
  await writeFile(path.join(fixture, ".webmcpify/proposed-tools.json"), JSON.stringify({ tools: [cart] }));
  assert.equal((await runSecurity({ path: fixture })).policy, "balance");
  const strictCommand = await runSecurity({ path: fixture, strict: true });
  assert.equal(strictCommand.policy, "strict", "--strict must select the actual strict audit policy");
  assert.ok(strictCommand.findings.some(finding => finding.code === "string-unbounded"));
  assert.equal(JSON.parse(await readFile(path.join(fixture, ".webmcpify/security-report.json"), "utf8")).policy, "strict");
  await writeFile(path.join(fixture, ".webmcpify/proposed-tools.json"), JSON.stringify({ tools: [anonymous] }));
  await assert.rejects(runSecurity({ path: fixture, strict: true }), /blocking access-control gaps/);

  const uiSecurity = { ...cart.security, executionScope: "ui-state" };
  const [click] = validateProposedTools({ tools: [{ ...cart, id: "select_tab", name: "select_tab", title: "Select tab", annotations: { ...cart.annotations, consequentialHint: false }, parameters: { type: "object", properties: {}, additionalProperties: false }, security: uiSecurity, implementation: { ...cart.implementation, action: "select tab" } }] }, discovery);
  const noApis = { ...discovery, apis: [] };
  assert.equal(auditToolSecurity([click], noApis, fixture, "strict").status, "pass");
  const serverUpdate = { ...click, name: "update_profile", title: "Update profile", implementation: { ...click.implementation, action: "update profile" }, security: { ...uiSecurity, executionScope: "backend" } };
  assert.equal(auditToolSecurity([serverUpdate], noApis, fixture, "strict").status, "block");
  // A reversible-sounding prefix, false annotation, or false scope cannot hide checkout.
  const disguisedPurchase = { ...click, name: "click_checkout", title: "Click checkout", implementation: { ...click.implementation, action: "click to checkout" } };
  const disguisedReport = auditToolSecurity([disguisedPurchase], noApis, fixture, "strict");
  assert.equal(disguisedReport.status, "block");
  assert.ok(disguisedReport.findings.some((item) => item.code === "backend-authorization-missing"));
  assert.ok(disguisedReport.findings.some((item) => item.code === "agent-binding-missing"));
  const crossOriginUi = { ...click, security: { ...uiSecurity, originScope: "restricted-cross-origin", allowedOrigins: ["*"] } };
  assert.equal(auditToolSecurity([crossOriginUi], noApis, fixture, "strict").status, "block");
  assert.throws(() => validateProposedTools({ tools: [{ ...click, security: { ...uiSecurity, executionScope: "anything" } }] }, discovery), /executionScope/);

  const balancedCheckout = auditToolSecurity([anonymous], discovery, fixture, "balance");
  assert.equal(balancedCheckout.status, "block");
  assert.ok(balancedCheckout.findings.some((item) => item.code === "agent-binding-missing"));
  const ignoredCheckout = auditToolSecurity([anonymous], discovery, fixture, "ignore");
  assert.equal(ignoredCheckout.policy, "ignore");
  assert.equal(ignoredCheckout.status, "pass");
  assert.equal(ignoredCheckout.findings.length, 0);
  console.log("Core security audit verification passed: strict, balance, and ignore policies");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
