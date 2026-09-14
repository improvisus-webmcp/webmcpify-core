#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import * as activities from "./activities.js";

async function main(): Promise<void> {
  let Worker: typeof import("@temporalio/worker").Worker;
  try {
    ({ Worker } = await import("@temporalio/worker"));
  } catch {
    throw new Error(
      "Temporal support is optional. Install @temporalio/client, @temporalio/worker, and @temporalio/workflow before starting the worker.",
    );
  }
  const worker = await Worker.create({
    workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
    activities,
    taskQueue: process.env.WEBMCPIFY_TEMPORAL_TASK_QUEUE ?? "webmcpify",
  });

  console.log(
    `[temporal] worker listening on task queue ${
      process.env.WEBMCPIFY_TEMPORAL_TASK_QUEUE ?? "webmcpify"
    }`
  );
  await worker.run();
}

main().catch((error: unknown) => {
  console.error(
    `[temporal] worker failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
