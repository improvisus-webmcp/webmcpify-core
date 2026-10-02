import type { DiscoveryResult } from "./discovery.js";

export type VerificationIssueSeverity = "error" | "warning";

export interface VerificationIssue {
  severity: VerificationIssueSeverity;
  code: string;
  message: string;
}

export interface VerificationContext {
  discovery?: DiscoveryResult;
  toolNames?: string[];
}

function literalSelectors(verify: string): string[] {
  return [...verify.matchAll(/(?:querySelector(?:All)?|getElementById)\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
}

export function validateVerifyExpression(
  verify: string,
  description: string,
  context: VerificationContext = {},
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const expression = verify.trim();
  if (!expression) return [{ severity: "error", code: "empty", message: "Verification expression cannot be empty." }];
  try {
    // Parse only; review validation never executes the expression.
    new Function(`return (${expression});`); // eslint-disable-line no-new-func
  } catch (error) {
    issues.push({ severity: "error", code: "syntax", message: `Verification is not valid JavaScript: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (/^(?:true|1|true\s*===\s*true|Boolean\(\s*true\s*\))$/i.test(expression.replace(/\s+/g, " "))) {
    issues.push({ severity: "error", code: "trivial", message: "Verification is a trivial always-true expression." });
  }
  if (/JSON\s*\.\s*parse\s*\(\s*(?:localStorage|sessionStorage)\s*\.\s*getItem\s*\(\s*(['"])[^'"]+\1\s*\)\s*\)\s*\./.test(expression)) {
    issues.push({ severity: "warning", code: "storage-null", message: "Fresh browser storage may be absent: directly dereferencing JSON.parse(getItem(...)) throws. Use null-safe storage checks, source-grounded empty-state defaults for rejection tests, and false for missing positive state." });
  }

  const selectors = literalSelectors(expression);
  if (selectors.length && context.discovery) {
    const sourceText = [...context.discovery.forms, ...context.discovery.buttons, ...context.discovery.actions, ...context.discovery.state]
      .map((signal) => signal.detail).join("\n");
    for (const selector of selectors) {
      if (!sourceText.includes(selector)) issues.push({ severity: "warning", code: "selector", message: `Selector or element id "${selector}" was not found in discovered source signals.` });
    }
  }
  const toolReferences = [...expression.matchAll(/(?:tools|toolName|name)\s*(?:===|==|includes\s*\()\s*["'`]([a-z][a-z0-9_-]*)["'`]/gi)].map((match) => match[1]);
  if (toolReferences.length && context.toolNames) {
    for (const tool of toolReferences) if (!context.toolNames.includes(tool)) issues.push({ severity: "warning", code: "tool", message: `Referenced tool "${tool}" is not in the proposed tool list.` });
  }
  const meaningfulWords = description.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const verifyLower = expression.toLowerCase();
  if (meaningfulWords.length > 0 && !meaningfulWords.some((word) => verifyLower.includes(word)) && !/(localstorage|sessionstorage|textcontent|innertext|queryselector|modelcontext|document\.)/.test(verifyLower)) {
    issues.push({ severity: "warning", code: "unrelated", message: "Verification does not visibly reference the task description; inspect it carefully." });
  }
  return issues;
}

export function verificationErrors(issues: VerificationIssue[]): VerificationIssue[] {
  return issues.filter((issue) => issue.severity === "error");
}
