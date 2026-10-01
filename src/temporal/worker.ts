#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import * as activities from "./activities.js";
import { temporalConnectionOptions } from "../lib/temporal.js";
import { coreActivityContext } from "./activity-context.js";

async function main(): Promise<void> {
  let sdk: typeof import("@temporalio/worker");
  try {
    sdk = await import("@temporalio/worker");
  } catch (error) {
    if (!(error instanceof Error)
      || !["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes((error as NodeJS.ErrnoException).code ?? "")
      || !/['"]@temporalio\/(?:worker|workflow)['"]/.test(error.message)) throw error;
    throw new Error(
      "Temporal support is optional. Install it before starting the worker: npm install @temporalio/client @temporalio/worker @temporalio/workflow",
    );
  }
  const connection = await sdk.NativeConnection.connect(temporalConnectionOptions());
  try {
  const worker = await sdk.Worker.create({
    connection,
    namespace: process.env.WEBMCPIFY_TEMPORAL_NAMESPACE ?? "default",
    interceptors: {
      activity: [coreActivityContext],
    },
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
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[temporal] worker failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
