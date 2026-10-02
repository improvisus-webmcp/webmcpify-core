#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

// This thin stdio adapter has no browser access. Core owns the authenticated
// loopback endpoint, the real Chrome MCP connection, and all execution evidence.
const config = JSON.parse(await readFile(process.argv[2], "utf8")) as { url: string; token: string };
const url = new URL(config.url);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("Invalid Core WebMCP bridge endpoint.");
const lines = createInterface({ input: process.stdin });
let queue = Promise.resolve();
lines.on("line", line => {
  queue = queue.then(async () => {
    let id: unknown = null;
    try {
      if (line.length > 1_048_576) throw new Error("Oversized request.");
      const request = JSON.parse(line) as { id?: unknown };
      id = request.id;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
        body: line,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error("Core task endpoint unavailable.");
      if (response.status !== 204) process.stdout.write(`${await response.text()}\n`);
    } catch {
      if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: "Core's Chrome DevTools WebMCP task connection is unavailable. Do not substitute another browser or claim execution." } })}\n`);
    }
  });
});
lines.on("close", () => { void queue.then(() => process.exit(0)); });
