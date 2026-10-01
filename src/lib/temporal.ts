const INSTALL_COMMAND =
  "npm install @temporalio/client @temporalio/worker @temporalio/workflow";

export async function loadTemporalClient(): Promise<
  typeof import("@temporalio/client")
> {
  try {
    return await import("@temporalio/client");
  } catch (error) {
    if (
      error instanceof Error &&
      ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes((error as NodeJS.ErrnoException).code ?? "")
      && /['"]@temporalio\/(?:client|worker|workflow)['"]/.test(error.message)
    ) {
      throw new Error(
        `Temporal support is optional. Install it before using durable workflows: ${INSTALL_COMMAND}`,
      );
    }
    throw error;
  }
}

/** Shared by durable clients and the worker; no SDK is loaded by this helper. */
export function temporalConnectionOptions(): {
  address: string;
  tls?: boolean;
  apiKey?: string;
} {
  const tls = process.env.WEBMCPIFY_TEMPORAL_TLS;
  if (tls !== undefined && tls !== "true" && tls !== "false") {
    throw new Error("WEBMCPIFY_TEMPORAL_TLS must be true or false.");
  }
  const apiKey = process.env.WEBMCPIFY_TEMPORAL_API_KEY;
  return {
    address: process.env.WEBMCPIFY_TEMPORAL_ADDRESS ?? "localhost:7233",
    ...(tls !== undefined ? { tls: tls === "true" } : apiKey ? { tls: true } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}
