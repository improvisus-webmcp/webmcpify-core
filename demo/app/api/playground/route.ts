import { NextResponse } from "next/server";

const injectionPattern = /ignore\s+(all|any|the)\s+(previous|earlier|above)|system\s+prompt|developer\s+message|reveal\s+(your|the)\s+instructions|bypass\s+(approval|security)/i;

type RequestBody = {
  operation?: unknown;
  value?: unknown;
  text?: unknown;
  paymentId?: unknown;
  currency?: unknown;
  approved?: unknown;
};

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.operation !== "string") {
    return NextResponse.json({ ok: false, error: "operation is required." }, { status: 400 });
  }

  switch (body.operation) {
    case "status":
      return NextResponse.json({ ok: true, operation: "status", service: "WebMCPify playground", serverTime: new Date().toISOString(), message: "Allowlisted same-origin API is reachable." });
    case "calculate": {
      const value = Number(body.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return NextResponse.json({ ok: false, error: "value must be a number from 0 to 100." }, { status: 400 });
      }
      return NextResponse.json({ ok: true, operation: "calculate", input: value, result: Math.round(value * 1.2 * 100) / 100, explanation: "A deterministic server-side demo calculation." });
    }
    case "inspect-text": {
      const text = typeof body.text === "string" ? body.text.slice(0, 500) : "";
      const suspicious = injectionPattern.test(text);
      return NextResponse.json({ ok: true, operation: "inspect-text", accepted: !suspicious, treatedAsData: true, reason: suspicious ? "Instruction-like text was quarantined as untrusted data." : "Text contains no known demo injection pattern." });
    }
    case "payment-preview": {
      const value = Number(body.value);
      const currency = typeof body.currency === "string" ? body.currency.toUpperCase() : "USD";
      if (!Number.isInteger(value) || value < 100 || value > 100000) {
        return NextResponse.json({ ok: false, error: "value must be an integer amount of cents from 100 to 100000." }, { status: 400 });
      }
      if (!["USD", "EUR", "GBP"].includes(currency)) {
        return NextResponse.json({ ok: false, error: "currency must be USD, EUR, or GBP." }, { status: 400 });
      }
      return NextResponse.json({ ok: true, operation: "payment-preview", paymentId: `demo_pi_${value}_${currency.toLowerCase()}`, amount: value, displayAmount: `${(value / 100).toFixed(2)} ${currency}`, status: "requires_human_confirmation", realCharge: false, provider: "WebMCPify local simulation" });
    }
    case "payment-confirm": {
      const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
      if (!/^demo_pi_[0-9]+_(usd|eur|gbp)$/.test(paymentId)) {
        return NextResponse.json({ ok: false, error: "paymentId must be a payment preview created by this playground." }, { status: 400 });
      }
      return NextResponse.json({ ok: true, operation: "payment-confirm", paymentId, status: "simulated_success", realCharge: false, message: "Demo payment confirmed locally; no provider or money movement was used." });
    }
    case "privacy-status":
      return NextResponse.json({ ok: true, operation: "privacy-status", collection: "No personal data is collected by this demo.", analytics: "off", storage: "No cookies or persistent identifiers are used.", sharing: "No data is sent to third parties." });
    case "privacy-export":
      return NextResponse.json({ ok: true, operation: "privacy-export", format: "json", records: [], redacted: true, message: "The demo has no personal records to export." });
    case "privacy-consent":
      if (body.approved !== true) return NextResponse.json({ ok: false, error: "Human approval is required before changing consent." }, { status: 403 });
      return NextResponse.json({ ok: true, operation: "privacy-consent", analytics: "enabled_for_demo_session_only", expires: "on page close", message: "This is a local demonstration; no tracking service was enabled." });
    default:
      return NextResponse.json({ ok: false, error: "Unknown operation. Use status, calculate, or inspect-text." }, { status: 400 });
  }
}
