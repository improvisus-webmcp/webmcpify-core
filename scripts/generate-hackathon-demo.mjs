import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "docs/hackathon/demo-video.html");
const output = resolve(root, "docs/hackathon/webmcpify-core-agent-demo.mp4");
const frameRate = 8;
const duration = 155;
const frameDir = await mkdtemp(join(tmpdir(), "webmcpify-core-video-"));
const debugPort = 43929;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = (command, args) => new Promise((done, reject) => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? done() : reject(new Error(`${command} exited with ${code}`)));
});

const chrome = spawn("google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(frameDir, "chrome")}`,
  "--window-size=1280,720", "about:blank",
], { stdio: "ignore" });

let socket;
try {
  let page;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
      if (response.ok) { page = await response.json(); break; }
    } catch {}
    await sleep(100);
  }
  if (!page) throw new Error("Chrome did not start.");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  await new Promise((done, reject) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolveRequest, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve: resolveRequest, reject });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: pathToFileURL(source).href });
  await sleep(300);
  for (let frame = 0; frame < frameRate * duration; frame += 1) {
    await send("Runtime.evaluate", { expression: `window.renderFrame(${frame / frameRate})` });
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
    await writeFile(join(frameDir, `frame-${String(frame).padStart(4, "0")}.jpg`), Buffer.from(shot.data, "base64"));
    if (frame % frameRate === 0) process.stdout.write(`Rendered ${frame / frameRate}s / ${duration}s\r`);
  }
  process.stdout.write(`Rendered ${duration}s / ${duration}s\n`);
  await run("ffmpeg", [
    "-y", "-framerate", String(frameRate), "-i", join(frameDir, "frame-%04d.jpg"),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", output,
  ]);
  console.log(`Created ${output} (${((await readFile(output)).byteLength / 1048576).toFixed(2)} MB)`);
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  await sleep(500);
  await rm(frameDir, { recursive: true, force: true });
}
