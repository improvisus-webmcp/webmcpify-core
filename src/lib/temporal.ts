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
      (error.message.includes("@temporalio/") ||
        (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND")
    ) {
      throw new Error(
        `Temporal support is optional. Install it before using durable workflows: ${INSTALL_COMMAND}`,
      );
    }
    throw error;
  }
}
