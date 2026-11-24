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

const MAX_SCHEMA_TEXT_ITEMS = 2_000;

function collectSchemaTextFields(node: unknown, depth: number, out: string[]): void {
  if (!node || typeof node !== "object" || depth > 12 || out.length >= MAX_SCHEMA_TEXT_ITEMS) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (out.length >= MAX_SCHEMA_TEXT_ITEMS) break;
      collectSchemaTextFields(item, depth + 1, out);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const strKey of ["description", "title", "default", "const"] as const) {
    const val = obj[strKey];
    if (typeof val === "string" && val.length > 0 && out.length < MAX_SCHEMA_TEXT_ITEMS) {
      out.push(val);
    }
  }
  for (const listKey of ["examples", "enum"] as const) {
    const list = obj[listKey];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (out.length >= MAX_SCHEMA_TEXT_ITEMS) break;
        if (typeof item === "string" && item.length > 0) {
          out.push(item);
        }
      }
    }
  }
  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    for (const propName of Object.keys(obj.properties as Record<string, unknown>)) {
      if (out.length >= MAX_SCHEMA_TEXT_ITEMS) break;
      if (propName.length > 0) out.push(propName);
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (out.length >= MAX_SCHEMA_TEXT_ITEMS) break;
    if (
      k !== "description" &&
      k !== "title" &&
      k !== "default" &&
      k !== "const" &&
      k !== "examples" &&
      k !== "enum" &&
      typeof v === "object" &&
      v !== null
    ) {
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
    const texts: string[] = [];
    if (typeof tool.name === "string") texts.push(tool.name);
    if (typeof tool.title === "string") texts.push(tool.title);
    if (typeof tool.description === "string") texts.push(tool.description);
    if (tool.inputSchema) collectSchemaTextFields(tool.inputSchema, 0, texts);
    if (tool.outputSchema) collectSchemaTextFields(tool.outputSchema, 0, texts);
    if (tool.annotations && typeof tool.annotations === "object" && !Array.isArray(tool.annotations)) {
      for (const val of Object.values(tool.annotations as Record<string, unknown>)) {
        if (typeof val === "string" && val.length > 0) texts.push(val);
      }
    }
    scanTextSurface(typeof tool.name === "string" ? tool.name : "(unknown)", texts.join("\n"), findings);
  }

  for (const prompt of prompts) {
    const texts: string[] = [];
    if (typeof prompt.name === "string") texts.push(prompt.name);
    if (typeof prompt.title === "string") texts.push(prompt.title);
    if (typeof prompt.description === "string") texts.push(prompt.description);
    if (Array.isArray(prompt.arguments)) {
      for (const arg of prompt.arguments) {
        if (!arg || typeof arg !== "object") continue;
        if (typeof arg.name === "string") texts.push(arg.name);
        if (typeof arg.description === "string") texts.push(arg.description);
      }
    }
    scanTextSurface(
      `prompt:${typeof prompt.name === "string" ? prompt.name : "(unknown)"}`,
      texts.join("\n"),
      findings,
    );
  }

  for (const resource of resources) {
    const texts: string[] = [];
    if (typeof resource.name === "string") texts.push(resource.name);
    if (typeof resource.uri === "string") texts.push(resource.uri);
    if (typeof resource.title === "string") texts.push(resource.title);
    if (typeof resource.description === "string") texts.push(resource.description);
    scanTextSurface(
      `resource:${typeof resource.name === "string" ? resource.name : "(unknown)"}`,
      texts.join("\n"),
      findings,
    );
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
