"use client";

import { useEffect, useRef, useState } from "react";

type PrivacyTool = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => unknown };
type PrivacyContext = { registerTool: (tool: PrivacyTool, options?: { signal?: AbortSignal }) => Promise<void> };

const callPrivacyApi = async (operation: string, approved = false) => {
  const response = await fetch("/api/playground", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, approved }) });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error || "Privacy API request failed."));
  return data;
};

export default function PrivacyPage() {
  const [native, setNative] = useState(false);
  const [approved, setApproved] = useState(false);
  const [consent, setConsent] = useState("off");
  const [result, setResult] = useState("No privacy tool has been run yet.");
  const approvalRef = useRef(approved);
  approvalRef.current = approved;
  const show = (value: unknown) => setResult(JSON.stringify(value, null, 2));
  const run = async (action: () => Promise<unknown>) => { try { show(await action()); } catch (error) { show({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }); } };

  useEffect(() => {
    const context = (document as unknown as { modelContext?: PrivacyContext }).modelContext;
    if (!context) return;
    const controller = new AbortController();
    const register = async () => {
      await context.registerTool({ name: "get_privacy_status", title: "Get privacy status", description: "Explain what this demo collects, stores, and shares. Read-only.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, consequentialHint: false }, execute: async (_input, options) => { if (options.signal.aborted) throw new Error("Tool execution was cancelled."); return callPrivacyApi("privacy-status"); } }, { signal: controller.signal });
      await context.registerTool({ name: "export_demo_privacy_data", title: "Export demo data", description: "Return the demo's redacted data export. This demo stores no personal records.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, consequentialHint: false }, execute: async (_input, options) => { if (options.signal.aborted) throw new Error("Tool execution was cancelled."); return callPrivacyApi("privacy-export"); } }, { signal: controller.signal });
      await context.registerTool({ name: "request_analytics_consent", title: "Request analytics consent", description: "Request session-only analytics consent. A human must approve in the page; an agent cannot approve its own request.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, consequentialHint: true }, execute: async (_input, options) => { if (options.signal.aborted) throw new Error("Tool execution was cancelled."); if (!approvalRef.current) return { ok: false, approvalRequired: true, message: "Ask the human to approve session analytics in the page, then retry." }; const data = await callPrivacyApi("privacy-consent", true); setConsent("session-only"); return { ...data, approvedByHuman: true }; } }, { signal: controller.signal });
      await context.registerTool({ name: "open_webmcpify_playground", title: "Open playground", description: "Navigate to the WebMCPify playground. Discover tools again after navigation because tools are scoped to the current page.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, consequentialHint: false }, execute: () => { window.location.assign("/playground"); return { ok: true, navigatingTo: "/playground" }; } }, { signal: controller.signal });
      setNative(true);
    };
    void register().catch(() => undefined);
    return () => controller.abort();
  }, []);

  return <main className="playground-page privacy-page"><nav className="nav wrap"><a className="logo" href="/"><b>W</b> WebMCPify</a><div className="navlinks"><a href="/">Home</a><a href="/playground">Playground</a><a href="#privacy-tools">Tools</a></div><a className="source" href="https://webmachinelearning.github.io/webmcp/" target="_blank" rel="noreferrer">WebMCP spec ↗</a></nav>
    <header className="playground-hero privacy-hero wrap"><p className="eyebrow"><i /> 06 / PRIVACY LAB</p><h1>Privacy is a <em>tool decision.</em></h1><p className="playground-lede">A page-scoped example of transparent data handling, redacted export, and consent that pauses for a human.</p><div className="playground-status"><span className={native ? "status on" : "status"}>● {native ? "4 PRIVACY TOOLS REGISTERED" : "ENABLE WEBMCP TO EXPOSE TOOLS"}</span><span>API: /api/playground</span></div></header>
    <section className="privacy-layout wrap" id="privacy-tools"><div className="playground-card"><p className="eyebrow">PRIVACY TOOL LAB</p><h2>Inspect, export, decide</h2><p>Every operation is explicit. The demo has no cookies, identifiers, personal records, or third-party analytics.</p><div className="playground-actions"><button onClick={() => run(() => callPrivacyApi("privacy-status"))}>Inspect privacy status</button><button onClick={() => run(() => callPrivacyApi("privacy-export"))}>Export redacted data</button><button onClick={() => run(async () => { if (!approved) return { ok: false, approvalRequired: true, message: "Approve session analytics below first." }; const data = await callPrivacyApi("privacy-consent", true); setConsent("session-only"); return data; })}>Enable session consent</button></div><pre className="playground-result">{result}</pre></div><aside className="playground-card approval-card"><p className="eyebrow">HUMAN CHECKPOINT</p><h2>Consent is opt-in</h2><p>An agent can explain the request, but only the human can enable this simulated session preference.</p><label className="approval-toggle"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /> I approve session-only analytics for this demo</label><div className="state-readout"><span>Analytics</span><strong>{consent}</strong></div><div className="state-readout"><span>Personal data</span><strong>none</strong></div></aside></section>
    <section className="playground-explain wrap"><div><p className="eyebrow">PRIVACY BY DESIGN</p><h2>Give agents <em>visibility, not secrets.</em></h2></div><div className="playground-points"><article><b>01 / MINIMIZE</b><h3>No sensitive inputs</h3><p>Tools do not accept names, emails, card numbers, tokens, or arbitrary URLs.</p></article><article><b>02 / TRANSPARENT</b><h3>Explain before access</h3><p>The privacy tool returns collection, storage, sharing, and retention details before consent.</p></article><article><b>03 / REVOCABLE</b><h3>Session-only consent</h3><p>The demo preference expires when the page closes and is never persisted.</p></article><article><b>04 / PAGE-SCOPED</b><h3>Rediscover after navigation</h3><p>This page exposes its own tools; agents must discover them again when moving between pages.</p></article></div></section>
    <footer className="footer wrap"><a className="logo" href="/"><b>W</b> WebMCPify</a><span><a href="/playground">Back to playground</a> · <a href="/">Home</a></span></footer>
  </main>;
}
