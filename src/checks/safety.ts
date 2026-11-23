import { detectSecretOrPathLeak, scrubText } from "../sanitize.js";
import type { CheckResult, McpPrompt, McpResource, McpTool, SafetyFinding, SafetySummary } from "../types.js";

// Zero-width spaces, directional overrides, and invisible BOM characters often used in tool poisoning.
const INVISIBLE_UNICODE_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;

const HIGH_RISK_INJECTION_PATTERNS: Array<{ rule: string; regex: RegExp; label: string }> = [
  {
    rule: "safety.prompt-injection-ignore",
    regex: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|earlier)\s+instructions?\b/i,
    label: "instruction-override directive",
  },
  {
    rule: "safety.prompt-injection-stealth",
    regex: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+to|reveal\s+to)\s+the\s+user\b/i,
    label: "stealth directive hiding actions from the user",
  },
  {
    rule: "safety.prompt-injection-tags",
    regex: /<\s{0,8}(?:\/\s{0,8})?(?:IMPORTANT|system|instructions|override)\s{0,8}>/i,
    label: "suspicious prompt-framing tag (<IMPORTANT> / <system>)",
  },
  {
    rule: "safety.prompt-injection-exfil",
    regex: /\b(?:exfiltrate|steal\s+(?:the\s+)?(?:keys?|tokens?|secrets?|credentials?))\b/i,
    label: "explicit credential/data exfiltration wording",
  },
  {
    rule: "safety.prompt-injection-sensitive-files",
    regex: /(?:~\/\.ssh|~\/\.aws\/credentials|\/etc\/passwd|id_rsa)\b/i,
    label: "reference to sensitive host credential files",
  },
];

const WARN_SHADOWING_PATTERNS: Array<{ rule: string; regex: RegExp; label: string }> = [
  {
    rule: "safety.cross-tool-shadowing",
    regex: /\b(?:always\s+call\s+this\s+tool\s+first|before\s+calling\s+any\s+other\s+tool|instead\s+of\s+calling)\b/i,
    label: "cross-tool hijacking / priority-override phrasing",
  },
];

function collectSchemaTextFields(node: unknown, depth: number, out: string[]): void {
  if (!node || typeof node !== "object" || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTextFields(item, depth + 1, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.description === "string" && obj.description.length > 0) {
    out.push(obj.description);
  }
  if (typeof obj.title === "string" && obj.title.length > 0) {
    out.push(obj.title);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "description" && k !== "title" && typeof v === "object" && v !== null) {
      collectSchemaTextFields(v, depth + 1, out);
    }
  }
}

function scanTextSurface(entityLabel: string, combined: string, findings: SafetyFinding[]): void {
  if (INVISIBLE_UNICODE_REGEX.test(combined)) {
    findings.push({
      tool: entityLabel,
      rule: "safety.invisible-unicode",
      severity: "fail",
      message: "Metadata contains invisible zero-width or BiDi Unicode characters.",
    });
  }

  for (const { rule, regex, label } of HIGH_RISK_INJECTION_PATTERNS) {
    const m = combined.match(regex);
    if (m) {
      findings.push({
        tool: entityLabel,
        rule,
        severity: "fail",
        message: `Metadata contains ${label}.`,
        excerpt: scrubText(m[0], 120),
      });
    }
  }

  for (const { rule, regex, label } of WARN_SHADOWING_PATTERNS) {
    const m = combined.match(regex);
    if (m) {
      findings.push({
        tool: entityLabel,
        rule,
        severity: "warn",
        message: `Metadata contains ${label}.`,
        excerpt: scrubText(m[0], 120),
      });
    }
  }
}

export function runSafetyChecks(
  tools: McpTool[],
  rawErrorBodies: string[],
  prompts: McpPrompt[] = [],
  resources: McpResource[] = [],
): { safety: SafetySummary; checks: CheckResult[] } {
  const findings: SafetyFinding[] = [];

  for (const tool of tools) {
    const texts: string[] = [tool.name];
    if (tool.title) texts.push(tool.title);
    if (tool.description) texts.push(tool.description);
    if (tool.inputSchema) collectSchemaTextFields(tool.inputSchema, 0, texts);
    scanTextSurface(tool.name, texts.join("\n"), findings);
  }

  for (const prompt of prompts) {
    const texts: string[] = [prompt.name];
    if (prompt.title) texts.push(prompt.title);
    if (prompt.description) texts.push(prompt.description);
    for (const arg of prompt.arguments ?? []) {
      texts.push(arg.name);
      if (arg.description) texts.push(arg.description);
    }
    scanTextSurface(`prompt:${prompt.name}`, texts.join("\n"), findings);
  }

  for (const resource of resources) {
    const texts: string[] = [resource.name, resource.uri];
    if (resource.title) texts.push(resource.title);
    if (resource.description) texts.push(resource.description);
    scanTextSurface(`resource:${resource.name}`, texts.join("\n"), findings);
  }

  const seenErrorLeakRules = new Set<string>();
  for (const raw of rawErrorBodies) {
    const leaks = detectSecretOrPathLeak(raw);
    for (const leak of leaks) {
      const rule = leak.includes("secret") ? "safety.error-secret-leak" : "safety.error-path-leak";
      if (seenErrorLeakRules.has(rule)) continue;
      seenErrorLeakRules.add(rule);
      findings.push({
        tool: null,
        rule,
        severity: leak.includes("secret") ? "fail" : "warn",
        message: `Server error response exposed a ${leak}.`,
        excerpt: scrubText(raw, 140),
      });
    }
  }

  const errors = findings.filter((f) => f.severity === "fail").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  const surfaceFindings = findings.filter((f) => f.tool !== null);
  const errorFindings = findings.filter((f) => f.tool === null);
  const totalEntities = tools.length + prompts.length + resources.length;

  const checks: CheckResult[] = [
    {
      id: "safety.tool-poisoning",
      category: "safety",
      title: "Tool & prompt poisoning / injection surface scan",
      status:
        surfaceFindings.some((f) => f.severity === "fail")
          ? "fail"
          : surfaceFindings.some((f) => f.severity === "warn")
            ? "warn"
            : "pass",
      summary:
        surfaceFindings.length === 0
          ? `Scanned ${totalEntities} metadata item(s) (${tools.length} tool(s), ${prompts.length} prompt(s), ${resources.length} resource(s)); no injection patterns found.`
          : `Flagged ${surfaceFindings.length} suspicious metadata finding(s).`,
      details: surfaceFindings
        .slice(0, 6)
        .map((f) => `[${f.severity}] ${f.tool}: ${f.message}${f.excerpt ? ` ("${f.excerpt}")` : ""}`),
    },
    {
      id: "safety.error-hygiene",
      category: "safety",
      title: "Error response secret & host-path hygiene",
      status:
        errorFindings.some((f) => f.severity === "fail")
          ? "fail"
          : errorFindings.some((f) => f.severity === "warn")
            ? "warn"
            : "pass",
      summary:
        errorFindings.length === 0
          ? "No secret tokens or host user paths observed in error responses."
          : `Observed ${errorFindings.length} sensitive leak(s) in server error responses.`,
      details: errorFindings
        .slice(0, 4)
        .map((f) => `[${f.severity}] ${f.message}`),
    },
  ];

  return {
    safety: {
      passed: errors === 0,
      errors,
      warnings,
      findings,
    },
    checks,
  };
}
