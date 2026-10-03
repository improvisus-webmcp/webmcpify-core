import { AsyncLocalStorage } from "node:async_hooks";

// Propagate cancellation without coupling ordinary commands to the Temporal SDK.
const operationSignal = new AsyncLocalStorage<AbortSignal>();
const operationDeadline = new AsyncLocalStorage<number>();

export function currentOperationSignal(): AbortSignal | undefined {
  return operationSignal.getStore();
}

export function withOperationSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return operationSignal.run(signal, operation);
}

export function currentOperationDeadline(): number | undefined {
  return operationDeadline.getStore();
}

export function withOperationDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  return operationDeadline.run(deadline, operation);
}
