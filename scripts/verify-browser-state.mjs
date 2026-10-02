import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { withManagedChrome } from "../dist/lib/browser.js";
import { closeScoringBrowser, resetScoringState, scoreTask, scoreTasks } from "../dist/lib/scoring.js";

const previousCdp = process.env.WEBMCPIFY_CDP_URL;
const evidence = calls => ({ source: "chrome-devtools-mcp", pageId: 1, discovered: true, calls, policyViolations: [] });
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  const scenarios = Array.from({ length: 13 }, (_, index) => `<span id="scenario-${index}">${index}</span>`).join("");
  response.end('<!doctype html><html><body>' + scenarios + '<button id="cart">Add</button><script>document.querySelector("button").onclick = () => { document.body.dataset.cart = "filled"; sessionStorage.setItem("cart", "filled"); document.cookie = "taskAuth=fixture; Path=/"; }</script></body></html>');
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const portProbe = createServer();
try {
  await new Promise((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolve); });
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  process.env.WEBMCPIFY_CDP_URL = `http://127.0.0.1:${port}`;
  const url = `http://127.0.0.1:${server.address().port}`;
  await withManagedChrome(url, async () => {
    const browser = await chromium.connectOverCDP(process.env.WEBMCPIFY_CDP_URL);
    const personalContext = browser.contexts()[0];
    await personalContext.addCookies([{ name: "personalAuth", value: "fixture", url }]);
    const session = await resetScoringState(url);
    try {
      assert.deepEqual(await session.page.context().cookies(), [], "Tasks start fresh without erasing personal state");
      await session.page.click("#cart");
      const task = { id: "cart", description: "Add cart item", requiredTools: ["add_item"], verify: 'document.body.dataset.cart === "filled" && sessionStorage.getItem("cart") === "filled" && document.cookie.includes("taskAuth=fixture")' };
      const result = await scoreTask(url, task, { page: session.page, resetStorage: false, toolEvidence: evidence([{ toolName: "add_item", status: "success" }]), requireToolEvidence: true });
      assert.equal(result.passed, true, result.detail);
      assert.equal(session.page.isClosed(), false, "Scoring must leave the caller-owned task page intact");
      await session.page.goto(`${url}/after-navigation`);
      const navigation = await scoreTask(url, { ...task, verify: 'location.pathname === "/after-navigation" && sessionStorage.getItem("cart") === "filled" && document.cookie.includes("taskAuth=fixture")' }, { page: session.page, resetStorage: false });
      assert.equal(navigation.passed, true, navigation.detail);
      assert.ok((await personalContext.cookies()).some((cookie) => cookie.name === "personalAuth"), "Scoring never clears reused CDP authentication");
      const rejectionTask = { ...task, setup: "Stay logged out; do not purchase anything.", expectedOutcome: "rejection", expectedError: "Must log in", requiredTools: ["checkout"], verify: '!document.body.dataset.purchased' };
      const rejection = await scoreTask(url, rejectionTask, { page: session.page, toolEvidence: evidence([{ toolName: "checkout", status: "error", error: "Must log in" }]), requireToolEvidence: true });
      assert.equal(rejection.passed, true, rejection.detail);
      assert.equal((await scoreTask(url, rejectionTask, { page: session.page, toolEvidence: evidence([{ toolName: "checkout", status: "error", error: "Network unavailable" }]), requireToolEvidence: true })).passed, false, "An unrelated failure must not pass a rejection test");
      await session.page.evaluate(() => { document.body.dataset.purchased = "true"; });
      assert.equal((await scoreTask(url, rejectionTask, { page: session.page, toolEvidence: evidence([{ toolName: "checkout", status: "error", error: "Must log in" }]), requireToolEvidence: true })).passed, false, "Expected errors must not hide forbidden state changes");
      await session.page.evaluate(() => { delete document.body.dataset.purchased; });
      assert.equal((await scoreTask(url, task, { resetStorage: false })).passed, false, "Never silently verify a fresh tab as live state");
      const largeSet = Array.from({ length: 14 }, (_, index) => ({ id: `read-scenario-${index}`, description: `Read rendered scenario ${index}`, verify: `document.querySelector('#scenario-${index}')?.textContent === '${index}'` }));
      const largeResult = await scoreTasks(url, largeSet);
      assert.equal(largeResult.total, 14, "The browser scorer must not truncate larger task sets");
      assert.equal(largeResult.passed, 13);
      assert.deepEqual(largeResult.results.map(result => result.task), largeSet.map(task => task.id));
      assert.equal(largeResult.results[13].passed, false, "A failing test beyond the old six-task cap must still be scored, not ignored");
    } finally {
      await session.close();
      await closeScoringBrowser();
      await browser.close();
    }
  });
  console.log("Real Chrome browser-state verification passed: same-tab DOM, session storage, cookies, navigation, expected rejection, personal context preservation, and all 14 tasks scored without truncation");
} finally {
  await closeScoringBrowser();
  await new Promise((resolve) => server.close(resolve));
  if (portProbe.listening) await new Promise((resolve) => portProbe.close(resolve));
  if (previousCdp === undefined) delete process.env.WEBMCPIFY_CDP_URL;
  else process.env.WEBMCPIFY_CDP_URL = previousCdp;
}
