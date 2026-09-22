import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DiscoveryResult } from "./discovery.js";
import type { ProposedTool } from "./tool-proposals.js";

export type SecuritySeverity = "block" | "review" | "info";
export const SECURITY_POLICIES = ["balance", "ignore", "strict"] as const;
export type SecurityPolicy = (typeof SECURITY_POLICIES)[number];

export interface SecurityFinding {
  code: string;
  severity: SecuritySeverity;
  toolId: string;
  message: string;
  recommendation: string;
}

export interface SecurityReport {
  version: 1;
  policy: SecurityPolicy;
  status: "pass" | "review" | "block";
  generatedAt: string;
  targetProject: string;
  summary: { tools: number; block: number; review: number; info: number };
  findings: SecurityFinding[];
  limitations: string[];
}

const REPLAY_PRONE = /(?:book|buy|checkout|create|delete|email|message|order|pay|post|publish|purchase|reserve|send|submit|transfer|update)/i;
const SENSITIVE_PARAMETER = /(?:age|birth|card|credit|debit|health|history|location|password|pregnan|secret|token)/i;
const HIGH_IMPACT_ACTION = /(?:\bcheckout\b|\b(?:buy|purchase|pay|transfer|withdraw|refund)\b|\b(?:place|submit|create|cancel)\s+(?:an?\s+)?order\b|\b(?:book|reserve)\b|\b(?:send|publish|post)\s+(?:an?\s+)?(?:email|message|comment|post)\b|\b(?:delete|close)\s+(?:my\s+|the\s+|an?\s+)?account\b|\bchange\s+(?:my\s+|the\s+)?password\b)/i;
const REVERSIBLE_UI_ACTION = /(?:\b(?:add|remove|clear|update)\b.{0,30}\bcart\b|\b(?:filter|search|sort)\b|\b(?:log|sign)[\s_-]?(?:in|out)\b|\blogin\b|\blogout\b)/i;
const BALANCED_ACCESS_CODES = new Set([
  "access-contract-missing",
  "backend-authorization-missing",
  "user-binding-missing",
  "agent-binding-missing",
  "quota-missing",
  "quota-unspecified",
  "replay-protection-missing",
  "idempotency-key-unspecified",
  "idempotency-key-unbound",
  "backend-evidence-not-discovered",
]);

export function resolveSecurityPolicy(policy?: string, fallback: SecurityPolicy = "strict"): SecurityPolicy {
  const selected = policy ?? fallback;
  if ((SECURITY_POLICIES as readonly string[]).includes(selected)) return selected as SecurityPolicy;
  throw new Error(`Unknown security policy "${selected}". Choose one of: ${SECURITY_POLICIES.join(", ")}.`);
}

function isHighImpactTool(tool: ProposedTool): boolean {
  const action = `${tool.name} ${tool.title} ${tool.implementation.action}`;
  return !REVERSIBLE_UI_ACTION.test(action) && HIGH_IMPACT_ACTION.test(action);
}

function finding(tool: ProposedTool, severity: SecuritySeverity, code: string, message: string, recommendation: string): SecurityFinding {
  return { code, severity, toolId: tool.id, message, recommendation };
}

function parameterRecords(tool: ProposedTool): Array<[string, Record<string, unknown>]> {
  return Object.entries(tool.parameters.properties).filter((entry): entry is [string, Record<string, unknown>] => (
    typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1])
  ));
}

/**
 * Audit the declared access contract. This deliberately does not claim that a
 * declaration proves the target backend implements it; the exact source patch
 * remains part of human review and the report records that limitation.
 */
export function auditToolSecurity(
  tools: ProposedTool[],
  discovery: DiscoveryResult,
  targetProject = discovery.targetProject,
  requestedPolicy: SecurityPolicy | string = "strict",
): SecurityReport {
  const policy = resolveSecurityPolicy(requestedPolicy);
  const strictFindings: SecurityFinding[] = [];

  for (const tool of tools) {
    const mutates = !tool.annotations.readOnlyHint;
    const consequential = tool.annotations.consequentialHint;
    const highImpact = isHighImpactTool(tool);
    const requiresConsequentialControls = consequential || (policy === "balance" && highImpact);
    const replayProne = REPLAY_PRONE.test(`${tool.name} ${tool.description} ${tool.implementation.action}`);
    const security = tool.security;

    if (!security) {
      strictFindings.push(finding(
        tool,
        mutates ? "block" : "review",
        "access-contract-missing",
        "The proposal does not declare who may call this tool or where access is enforced.",
        "Add a security contract and make its claims match the reviewed source patch.",
      ));
    } else {
      if (mutates && !["backend", "server-action"].includes(security.authorization)) {
        strictFindings.push(finding(tool, "block", "backend-authorization-missing", "A state-changing tool relies on client-only or no authorization.", "Enforce authorization in the underlying server/API path used by the human interface."));
      }
      if (requiresConsequentialControls && security.userAuthentication !== "required") {
        strictFindings.push(finding(tool, "block", "user-binding-missing", "A consequential tool is not bound to an authenticated user.", "Require and verify the user identity in the backend action."));
      }
      if (requiresConsequentialControls && security.agentIdentity !== "required") {
        strictFindings.push(finding(tool, "block", "agent-binding-missing", "A consequential tool does not require a verified agent identity.", "Require a verified agent principal and bind it to the user, origin, tool, and short-lived grant."));
      }
      if (mutates && !security.rateLimit.enforced) {
        strictFindings.push(finding(tool, requiresConsequentialControls ? "block" : "review", "quota-missing", "No per-tool usage limit is declared for this state-changing action.", "Enforce a backend quota scoped to the agent/user/tool as appropriate."));
      }
      if (security.rateLimit.enforced && (!security.rateLimit.limit || !security.rateLimit.windowSeconds)) {
        strictFindings.push(finding(tool, "review", "quota-unspecified", "Rate limiting is declared without a numeric limit and window.", "Record the enforced call limit and window so the policy is reviewable."));
      }
      if (mutates && (requiresConsequentialControls || replayProne) && !security.idempotency.enforced) {
        strictFindings.push(finding(tool, requiresConsequentialControls ? "block" : "review", "replay-protection-missing", "This action may be duplicated by retries but declares no idempotency protection.", "Require a backend idempotency key and return the original structured result for safe retries."));
      }
      if (security.idempotency.enforced && !security.idempotency.keyParameter) {
        strictFindings.push(finding(tool, "review", "idempotency-key-unspecified", "Idempotency is declared but its request key is not identified.", "Name the bounded input/header used as the backend idempotency key."));
      }
      if (mutates && security.idempotency.enforced && security.idempotency.keyParameter && !(security.idempotency.keyParameter in tool.parameters.properties)) {
        strictFindings.push(finding(tool, requiresConsequentialControls ? "block" : "review", "idempotency-key-unbound", `Idempotency key "${security.idempotency.keyParameter}" is not present in the tool input schema.`, "Expose a bounded idempotency key in the request contract and verify it in the backend."));
      }
      if (security.originScope === "restricted-cross-origin") {
        const origins = security.allowedOrigins ?? [];
        if (origins.length === 0 || origins.some((origin) => !/^https:\/\/[^/]+$/i.test(origin))) {
          strictFindings.push(finding(tool, "block", "origin-allowlist-invalid", "Cross-origin exposure is not backed by an explicit HTTPS origin allowlist.", "List only exact trusted HTTPS origins, or keep the tool same-origin."));
        }
      }
    }

    if (tool.description.length > 500) {
      strictFindings.push(finding(tool, "review", "description-budget", "The tool description exceeds 500 characters.", "Shorten it to reduce context cost and injection surface."));
    }

    for (const [name, schema] of parameterRecords(tool)) {
      if (name.length > 30) strictFindings.push(finding(tool, "review", "parameter-name-budget", `Parameter "${name}" exceeds 30 characters.`, "Use a shorter stable parameter name."));
      if (schema.type === "string" && (typeof schema.maxLength !== "number" || schema.maxLength <= 0)) {
        strictFindings.push(finding(tool, "review", "string-unbounded", `String parameter "${name}" has no positive maxLength.`, "Add a realistic maximum input length and validate it again in the backend."));
      }
      if (typeof schema.description === "string" && schema.description.length > 150) {
        strictFindings.push(finding(tool, "review", "parameter-description-budget", `Parameter "${name}" has a description longer than 150 characters.`, "Shorten the description and keep instructions out of schema text."));
      }
      if (SENSITIVE_PARAMETER.test(name)) {
        strictFindings.push(finding(tool, "review", "sensitive-parameter", `Parameter "${name}" may request sensitive or identifying data.`, "Confirm it is essential, narrowly constrained, and never accepted merely for agent convenience."));
      }
    }

    if (mutates && discovery.apis.length === 0) {
      strictFindings.push(finding(tool, "review", "backend-evidence-not-discovered", "Discovery found no API/server signal supporting this state-changing tool.", "Inspect the exact patch and confirm that the real backend path—not browser-only state—enforces the action."));
    }
  }

  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const findings = policy === "strict"
    ? strictFindings
    : policy === "ignore"
      ? []
      : strictFindings.filter((item) => {
          if (item.code === "origin-allowlist-invalid") return true;
          const tool = toolsById.get(item.toolId);
          if (!tool || !isHighImpactTool(tool)) return false;
          return BALANCED_ACCESS_CODES.has(item.code);
        });

  const summary = {
    tools: tools.length,
    block: findings.filter((item) => item.severity === "block").length,
    review: findings.filter((item) => item.severity === "review").length,
    info: findings.filter((item) => item.severity === "info").length,
  };
  const status = summary.block > 0 ? "block" : summary.review > 0 ? "review" : "pass";
  return {
    version: 1,
    policy,
    status,
    generatedAt: new Date().toISOString(),
    targetProject,
    summary,
    findings,
    limitations: [
      ...(policy === "balance" ? ["Balanced policy reports access-control gaps only for high-impact actions and invalid cross-origin allowlists."] : []),
      ...(policy === "ignore" ? ["Automated security findings were skipped by the ignore policy; human patch approval is still required."] : []),
      "Static declarations and source signals are not proof of runtime enforcement.",
      "Core does not yet define or verify a universal third-party agent-attestation token.",
      "Production quotas, nonces, capability grants, and audit storage must be enforced by the target backend.",
    ],
  };
}

export function securityReportPath(sitePath: string): string {
  return path.join(sitePath, ".webmcpify", "security-report.json");
}

export async function writeSecurityReport(sitePath: string, report: SecurityReport): Promise<string> {
  const output = securityReportPath(sitePath);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return output;
}
