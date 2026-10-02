import { createServer } from "node:net";
import { withManagedChrome } from "../dist/lib/browser.js";

const previousCdp = process.env.WEBMCPIFY_CDP_URL;
const previousFlag = process.env.WEBMCPIFY_VERIFY_REVIEW_BROWSER;
const probe = createServer();
try {
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  process.env.WEBMCPIFY_CDP_URL = `http://127.0.0.1:${port}`;
  process.env.WEBMCPIFY_VERIFY_REVIEW_BROWSER = "1";
  await withManagedChrome("about:blank", async () => { await import("./verify-partial-review.mjs"); });
  console.log("Real-browser review passed: read-only tasks, busy controls/other tabs, refresh lock, automatic reopen, repeated removal, and final confirmation");
} finally {
  if (probe.listening) await new Promise(resolve => probe.close(resolve));
  if (previousCdp === undefined) delete process.env.WEBMCPIFY_CDP_URL;
  else process.env.WEBMCPIFY_CDP_URL = previousCdp;
  if (previousFlag === undefined) delete process.env.WEBMCPIFY_VERIFY_REVIEW_BROWSER;
  else process.env.WEBMCPIFY_VERIFY_REVIEW_BROWSER = previousFlag;
}
