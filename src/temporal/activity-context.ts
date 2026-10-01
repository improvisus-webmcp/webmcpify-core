import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { withOperationSignal } from "../lib/operation-context.js";

/** Keep long-running Core operations alive and propagate SDK cancellation. */
export const coreActivityContext: ActivityInterceptorsFactory = (context) => ({
  inbound: {
    async execute(input, next) {
      context.heartbeat();
      const heartbeat = setInterval(() => context.heartbeat(), 5_000);
      try { return await withOperationSignal(context.cancellationSignal, () => next(input)); }
      catch (error) {
        // Core reports sanitized command failures; restore the SDK's actual
        // cancellation failure when that failure came from cancellation.
        if (context.cancellationSignal.aborted) await context.cancelled;
        throw error;
      }
      finally { clearInterval(heartbeat); }
    },
  },
});
