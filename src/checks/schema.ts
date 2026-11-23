import type { CheckResult, McpTool, ProviderCompatibility, ProviderId, ProviderIssue } from "../types.js";

const OPENAI_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const ANTHROPIC_NAME_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const GEMINI_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/;
const CURSOR_TOOL_CAP = 40;
const MAX_SCHEMA_DEPTH = 20;

const GEMINI_FAIL_KEYWORDS = [
  "$ref",
  "$defs",
  "definitions",
  "oneOf",
  "allOf",
  "not",
  "const",
  "patternProperties",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "dependentRequired",
  "unevaluatedProperties",
] as const;

// Note: `default` is officially supported by Gemini's Schema protobuf (field 25) and Vertex AI.
const GEMINI_WARN_KEYWORDS = ["$schema", "additionalProperties"] as const;

const OPENAI_UNSUPPORTED_KEYWORDS = [
  "oneOf",
  "not",
  "patternProperties",
  "dependentRequired",
  "unevaluatedProperties",
] as const;

function walkSchema(
  node: unknown,
  currentPath: string,
  depth: number,
  visitor: (obj: Record<string, unknown>, schemaPath: string) => void,
): void {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > MAX_SCHEMA_DEPTH) {
    return;
  }
  const obj = node as Record<string, unknown>;
  visitor(obj, currentPath);

  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    for (const [prop, child] of Object.entries(obj.properties as Record<string, unknown>)) {
      walkSchema(child, `${currentPath}.properties.${prop}`, depth + 1, visitor);
    }
  }
  if (obj.items && typeof obj.items === "object") {
    if (Array.isArray(obj.items)) {
      obj.items.forEach((child, i) => walkSchema(child, `${currentPath}.items[${i}]`, depth + 1, visitor));
    } else {
      walkSchema(obj.items, `${currentPath}.items`, depth + 1, visitor);
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(obj[key])) {
      (obj[key] as unknown[]).forEach((child, i) =>
        walkSchema(child, `${currentPath}.${key}[${i}]`, depth + 1, visitor),
      );
    }
  }
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    walkSchema(obj.additionalProperties, `${currentPath}.additionalProperties`, depth + 1, visitor);
  }
  if (obj.$defs && typeof obj.$defs === "object" && !Array.isArray(obj.$defs)) {
    for (const [defName, child] of Object.entries(obj.$defs as Record<string, unknown>)) {
      walkSchema(child, `${currentPath}.$defs.${defName}`, depth + 1, visitor);
    }
  }
  if (obj.definitions && typeof obj.definitions === "object" && !Array.isArray(obj.definitions)) {
    for (const [defName, child] of Object.entries(obj.definitions as Record<string, unknown>)) {
      walkSchema(child, `${currentPath}.definitions.${defName}`, depth + 1, visitor);
    }
  }
  if (Array.isArray(obj.prefixItems)) {
    obj.prefixItems.forEach((child, i) =>
      walkSchema(child, `${currentPath}.prefixItems[${i}]`, depth + 1, visitor),
    );
  }
}

function checkToolForProvider(tool: McpTool, provider: ProviderId): ProviderIssue[] {
  const issues: ProviderIssue[] = [];
  const schema = tool.inputSchema;

  // Name validation per provider
  if (provider === "openai" && !OPENAI_NAME_REGEX.test(tool.name)) {
    issues.push({
      tool: tool.name,
      rule: "openai.tool-name",
      severity: "fail",
      message: `Tool name "${tool.name}" violates OpenAI pattern ^[a-zA-Z0-9_-]{1,64}$.`,
    });
  } else if (provider === "anthropic" && !ANTHROPIC_NAME_REGEX.test(tool.name)) {
    issues.push({
      tool: tool.name,
      rule: "anthropic.tool-name",
      severity: "fail",
      message: `Tool name "${tool.name}" violates Anthropic pattern ^[a-zA-Z0-9_-]{1,128}$.`,
    });
  } else if (provider === "gemini" && !GEMINI_NAME_REGEX.test(tool.name)) {
    issues.push({
      tool: tool.name,
      rule: "gemini.tool-name",
      severity: "fail",
      message: `Tool name "${tool.name}" must start with a letter or underscore and match ^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$.`,
    });
  } else if (provider === "cursor" && (/\s/.test(tool.name) || tool.name.length > 64)) {
    issues.push({
      tool: tool.name,
      rule: "cursor.tool-name",
      severity: "fail",
      message: `Tool name "${tool.name}" contains whitespace or exceeds 64 characters.`,
    });
  }

  // Root schema validation
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    issues.push({
      tool: tool.name,
      rule: `${provider}.root-schema`,
      severity: "fail",
      message: "Tool is missing an object inputSchema.",
      path: "$",
    });
    return issues;
  }

  if (schema.type !== "object") {
    issues.push({
      tool: tool.name,
      rule: `${provider}.root-type-object`,
      severity: "fail",
      message: `Root inputSchema.type must be "object" (got ${JSON.stringify(schema.type)}).`,
      path: "$",
    });
  }

  // Top-level combinators rejected by OpenAI / Anthropic / Gemini
  if (provider !== "cursor") {
    for (const kw of ["oneOf", "anyOf", "allOf", "not"] as const) {
      if (schema[kw] !== undefined) {
        issues.push({
          tool: tool.name,
          rule: `${provider}.root-combinator`,
          severity: "fail",
          message: `Top-level "${kw}" on tool inputSchema is rejected by ${provider}.`,
          path: `$.${kw}`,
        });
      }
    }
  }

  if (provider === "anthropic" && (!tool.description || tool.description.trim().length === 0)) {
    issues.push({
      tool: tool.name,
      rule: "anthropic.description",
      severity: "warn",
      message: "Tool is missing a description (hurts Claude tool selection).",
    });
  }

  if (provider === "cursor") {
    if (!tool.annotations || Object.keys(tool.annotations).length === 0) {
      issues.push({
        tool: tool.name,
        rule: "cursor.annotations",
        severity: "warn",
        message: "Tool does not declare MCP safety annotations (readOnlyHint / destructiveHint).",
      });
    }
  }

  // Deep schema walk
  const seenProviderRulePath = new Set<string>();
  const addUnique = (issue: ProviderIssue) => {
    const key = `${issue.rule}|${issue.path ?? ""}`;
    if (seenProviderRulePath.has(key)) return;
    seenProviderRulePath.add(key);
    issues.push(issue);
  };

  walkSchema(schema, "$", 0, (obj, schemaPath) => {
    if (provider === "openai") {
      if (obj.type === "array" && obj.items === undefined) {
        addUnique({
          tool: tool.name,
          rule: "openai.array-items",
          severity: "fail",
          message: "Array schema is missing required \"items\" definition.",
          path: schemaPath,
        });
      }
      if (Array.isArray(obj.enum) && obj.enum.length === 0) {
        addUnique({
          tool: tool.name,
          rule: "openai.empty-enum",
          severity: "fail",
          message: "Empty enum array is rejected by OpenAI.",
          path: `${schemaPath}.enum`,
        });
      }
      for (const kw of OPENAI_UNSUPPORTED_KEYWORDS) {
        if (obj[kw] !== undefined && !(schemaPath === "$" && (kw === "oneOf" || kw === "not"))) {
          addUnique({
            tool: tool.name,
            rule: `openai.keyword-${kw}`,
            severity: "warn",
            message: `Schema keyword "${kw}" is unsupported in OpenAI strict tool schemas.`,
            path: `${schemaPath}.${kw}`,
          });
        }
      }
      if (obj.type === "object" && obj.properties !== undefined && obj.additionalProperties !== false) {
        addUnique({
          tool: tool.name,
          rule: "openai.strict-additional-properties",
          severity: "warn",
          message: "Object schema omits additionalProperties: false (incompatible with OpenAI strict: true).",
          path: schemaPath,
        });
      }
    }

    if (provider === "gemini") {
      if (Array.isArray(obj.type)) {
        addUnique({
          tool: tool.name,
          rule: "gemini.union-type-array",
          severity: "fail",
          message: `JSON Schema union type array ${JSON.stringify(obj.type)} is rejected by Gemini OpenAPI 3.0 schema validation.`,
          path: `${schemaPath}.type`,
          fix: "Use a single primitive type instead of a JSON Schema type array.",
        });
      }
      for (const kw of GEMINI_FAIL_KEYWORDS) {
        if (obj[kw] !== undefined && !(schemaPath === "$" && (kw === "oneOf" || kw === "allOf" || kw === "not"))) {
          const fix =
            kw === "exclusiveMinimum"
              ? "Replace exclusiveMinimum with inclusive minimum (for integers, use minimum: N + 1)."
              : kw === "exclusiveMaximum"
                ? "Replace exclusiveMaximum with inclusive maximum (for integers, use maximum: N - 1)."
                : kw === "$ref" || kw === "$defs" || kw === "definitions"
                  ? "Inline referenced sub-schemas instead of using $ref/$defs."
                  : `Remove or rewrite "${kw}" into standard OpenAPI 3.0 properties.`;
          addUnique({
            tool: tool.name,
            rule: `gemini.unsupported-${kw}`,
            severity: "fail",
            message: `Keyword "${kw}" is rejected by Google Gemini tool schema validation.`,
            path: `${schemaPath}.${kw}`,
            fix,
          });
        }
      }
      for (const kw of GEMINI_WARN_KEYWORDS) {
        if (obj[kw] !== undefined) {
          addUnique({
            tool: tool.name,
            rule: `gemini.warn-${kw}`,
            severity: "warn",
            message: `Keyword "${kw}" is rejected by Gemini OpenAPI parameters unless clients strip it or use parametersJsonSchema.`,
            path: `${schemaPath}.${kw}`,
          });
        }
      }
      if (obj.anyOf !== undefined && schemaPath !== "$") {
        addUnique({
          tool: tool.name,
          rule: "gemini.anyOf",
          severity: "warn",
          message: 'Nested "anyOf" can fail on Gemini OpenAPI 3.0 endpoints depending on client translation.',
          path: `${schemaPath}.anyOf`,
        });
      }
      if (obj.type === "array" && obj.items === undefined) {
        addUnique({
          tool: tool.name,
          rule: "gemini.array-items",
          severity: "fail",
          message: 'Array schema is missing required "items" definition.',
          path: schemaPath,
        });
      }
    }
  });

  return issues;
}

export function runSchemaChecks(tools: McpTool[]): {
  providers: Record<ProviderId, ProviderCompatibility>;
  checks: CheckResult[];
} {
  const providerIds: ProviderId[] = ["openai", "anthropic", "gemini", "cursor"];
  const providers = {} as Record<ProviderId, ProviderCompatibility>;
  const checks: CheckResult[] = [];

  for (const provider of providerIds) {
    const allIssues: ProviderIssue[] = [];
    let compatibleTools = 0;

    for (const tool of tools) {
      const toolIssues = checkToolForProvider(tool, provider);
      allIssues.push(...toolIssues);
      if (!toolIssues.some((i) => i.severity === "fail")) {
        compatibleTools += 1;
      }
    }

    if (provider === "cursor" && tools.length > CURSOR_TOOL_CAP) {
      allIssues.push({
        tool: "(server)",
        rule: "cursor.tool-count-cap",
        severity: "warn",
        message: `Server exposes ${tools.length} tools, exceeding Cursor's ${CURSOR_TOOL_CAP}-tool active budget.`,
      });
    }

    const errors = allIssues.filter((i) => i.severity === "fail").length;
    const warnings = allIssues.filter((i) => i.severity === "warn").length;
    const compatible = errors === 0;

    providers[provider] = {
      provider,
      compatible,
      compatibleTools,
      totalTools: tools.length,
      errors,
      warnings,
      issues: allIssues,
    };

    const label =
      provider === "openai"
        ? "OpenAI"
        : provider === "anthropic"
          ? "Anthropic (Claude)"
          : provider === "gemini"
            ? "Google Gemini"
            : "Cursor";

    const orderedIssues = [
      ...allIssues.filter((i) => i.severity === "fail"),
      ...allIssues.filter((i) => i.severity === "warn"),
    ];

    checks.push({
      id: `schema.compat-${provider}`,
      category: "schema",
      title: `${label} tool schema compatibility`,
      status: tools.length === 0 ? "skip" : errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
      summary:
        tools.length === 0
          ? "No tools exposed to check."
          : errors === 0 && warnings === 0
            ? `All ${tools.length}/${tools.length} tool(s) compatible with ${label}.`
            : `${compatibleTools}/${tools.length} tool(s) compatible with ${label} (${errors} error(s), ${warnings} warning(s)).`,
      details: orderedIssues
        .slice(0, 8)
        .map((i) => `[${i.severity}] ${i.tool}${i.path ? ` (${i.path})` : ""}: ${i.message}`),
    });
  }

  return { providers, checks };
}
