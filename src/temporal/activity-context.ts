import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { AsyncLocalStorage } from "node:async_hooks";
import { withOperationSignal, withOperationDeadline } from "../lib/operation-context.js";

const reviewReporter = new AsyncLocalStorage<(url: string) => Promise<void>>();

/** Report the actual bound port, including review's occupied-port fallback. */
export async function reportTemporalReviewUrl(url: string): Promise<void> {
  await reviewReporter.getStore()?.(url);
}

/** Keep long-running Core operations alive and propagate SDK cancellation. */
export const coreActivityContext: ActivityInterceptorsFactory = (context) => ({
  inbound: {
    async execute(input, next) {
      const heartbeatFailure = new AbortController();
      const deadlineFailure = new AbortController();
      const budget = context.info?.startToCloseTimeoutMs;
      const deadline = budget ? Date.now() + budget : undefined;
      const signal = AbortSignal.any([context.cancellationSignal, heartbeatFailure.signal, deadlineFailure.signal]);
      let deadlineTimer: NodeJS.Timeout | undefined;
      const armDeadline = () => {
        const remaining = deadline! - Date.now();
        if (remaining <= 0) {
          deadlineFailure.abort(new Error("Temporal activity deadline elapsed; its local operation was cancelled. Inspect private state before retrying."));
          return;
        }
        // Node timers overflow beyond ~24.8 days; owner review can be longer.
        deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
        deadlineTimer.unref();
      };
      if (deadline !== undefined) armDeadline();
      const beat = () => {
        try { context.heartbeat(); }
        catch (error) { heartbeatFailure.abort(error); }
      };
      beat();
      const heartbeat = setInterval(beat, 5_000);
      try {
        signal.throwIfAborted();
        const operation = () => reviewReporter.run(async url => {
          const execution = context.info.workflowExecution;
          if (!execution) throw new Error("A durable review requires a workflow execution identity.");
          await context.client.workflow.getHandle(execution.workflowId, execution.runId).signal("coreReviewReady", url);
        }, () => withOperationSignal(signal, () => next(input)));
        const result = deadline ? await withOperationDeadline(deadline, operation) : await operation();
        // Some commands deliberately catch provider failures to save artifacts.
        // Such a return must not turn an SDK cancellation into activity success.
        signal.throwIfAborted();
        return result;
      }
      catch (error) {
        // Core reports sanitized command failures; restore the SDK's actual
        // cancellation failure when that failure came from cancellation.
        if (context.cancellationSignal.aborted) await context.cancelled;
        throw error;
      }
      finally { clearInterval(heartbeat); if (deadlineTimer) clearTimeout(deadlineTimer); }
    },
  },
});
