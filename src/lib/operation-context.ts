import { AsyncLocalStorage } from "node:async_hooks";

// Propagate cancellation without coupling ordinary commands to the Temporal SDK.
const operationSignal = new AsyncLocalStorage<AbortSignal>();

export function currentOperationSignal(): AbortSignal | undefined {
  return operationSignal.getStore();
}

export function withOperationSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return operationSignal.run(signal, operation);
}
