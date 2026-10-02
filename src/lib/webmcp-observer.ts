import { isDeepStrictEqual } from "node:util";
import type { Page } from "playwright-core";

/** Read-only observation: capabilities are still invoked only through Chrome MCP. */
export async function observeWebMcpExecution(page: Page, toolName: string, input = "{}"): Promise<{
  error(): string | undefined;
  waitForError(timeoutMs?: number): Promise<string | undefined>;
  diagnostics(): unknown[];
  close(): Promise<void>;
}> {
  const expectedInput: unknown = JSON.parse(input);
  const session = await page.context().newCDPSession(page);
  let invocationId: string | undefined;
  let duplicate = false;
  let errorText: string | undefined;
  let notify: (() => void) | undefined;
  const events: unknown[] = [];
  session.on("WebMCP.toolInvoked", event => {
    if (event.toolName !== toolName) return;
    try {
      const actual = typeof event.input === "string" ? JSON.parse(event.input) : event.input;
      if (events.length < 20) events.push({ event: "invoked", invocationId: event.invocationId, inputMatched: isDeepStrictEqual(actual, expectedInput) });
      if (!isDeepStrictEqual(actual, expectedInput)) return;
      if (invocationId !== undefined) duplicate = true;
      invocationId = event.invocationId;
    } catch { /* Unknown input cannot be attributed to the approved call. */ }
  });
  session.on("WebMCP.toolResponded", event => {
    if (events.length < 20) events.push({ event: "responded", invocationId: event.invocationId, status: event.status, hasErrorText: Boolean(event.errorText), exceptionDescription: event.exception?.description?.split("\n")[0] });
    if (event.invocationId !== invocationId || event.status !== "Error") return;
    // Chrome may put a thrown guard in a Runtime.RemoteObject while the
    // pinned MCP server serializes only an empty errorText. Never infer this
    // error from arbitrary console messages, a final report or another call.
    errorText = event.errorText?.trim()
      || event.exception?.description?.split("\n")[0]?.trim();
    notify?.();
  });
  try {
    await session.send("WebMCP.enable");
    const error = () => duplicate ? undefined : errorText;
    return {
      error,
      waitForError: async (timeoutMs = 500) => {
        if (error() || duplicate) return error();
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { notify = undefined; resolve(); }, timeoutMs);
          notify = () => { clearTimeout(timer); notify = undefined; resolve(); };
        });
        return error();
      },
      diagnostics: () => events,
      close: async () => { notify?.(); await session.detach().catch(() => undefined); },
    };
  } catch (error) { await session.detach().catch(() => undefined); throw error; }
}
