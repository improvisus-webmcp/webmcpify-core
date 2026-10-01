import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { withManagedChrome } from "../dist/lib/browser.js";
import { closeScoringBrowser, resetScoringState, scoreTask } from "../dist/lib/scoring.js";

const previousCdp = process.env.WEBMCPIFY_CDP_URL;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end('<!doctype html><html><body><button id="cart">Add</button><script>document.querySelector("button").onclick = () => { document.body.dataset.cart = "filled"; sessionStorage.setItem("cart", "filled"); document.cookie = "taskAuth=fixture; Path=/"; }</script></body></html>');
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
      const result = await scoreTask(url, task, { page: session.page, resetStorage: false, agentOutput: "add_item completed", requireToolEvidence: true });
      assert.equal(result.passed, true, result.detail);
      assert.equal(session.page.isClosed(), false, "Scoring must leave the caller-owned task page intact");
      await session.page.goto(`${url}/after-navigation`);
      const navigation = await scoreTask(url, { ...task, verify: 'location.pathname === "/after-navigation" && sessionStorage.getItem("cart") === "filled" && document.cookie.includes("taskAuth=fixture")' }, { page: session.page, resetStorage: false });
      assert.equal(navigation.passed, true, navigation.detail);
      assert.ok((await personalContext.cookies()).some((cookie) => cookie.name === "personalAuth"), "Scoring never clears reused CDP authentication");
      const rejection = await scoreTask(url, { ...task, expectedOutcome: "rejection", expectedError: "Must log in", requiredTools: ["checkout"], verify: '!document.body.dataset.purchased' }, { page: session.page, agentOutput: "checkout: Must log in" });
      assert.equal(rejection.passed, true, rejection.detail);
      assert.equal((await scoreTask(url, task, { resetStorage: false })).passed, false, "Never silently verify a fresh tab as live state");
    } finally {
      await session.close();
      await closeScoringBrowser();
      await browser.close();
    }
  });
  console.log("Real Chrome browser-state verification passed: same-tab DOM, session storage, cookies, navigation, expected rejection, personal context preservation");
} finally {
  await closeScoringBrowser();
  await new Promise((resolve) => server.close(resolve));
  if (portProbe.listening) await new Promise((resolve) => portProbe.close(resolve));
  if (previousCdp === undefined) delete process.env.WEBMCPIFY_CDP_URL;
  else process.env.WEBMCPIFY_CDP_URL = previousCdp;
}
