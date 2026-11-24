import { countTokens as countO200kTokens } from "gpt-tokenizer/encoding/o200k_base";
import type {
  CheckResult,
  ContextBudgetSummary,
  McpTool,
  TokenizerMode,
  ToolTokenEntry,
} from "../types.js";

const WARN_TOKEN_BUDGET = 6_000;
const FAIL_TOKEN_BUDGET = 16_000;
const MAX_RECOMMENDED_DESC_CHARS = 1_500;
const SAFE_TOKENIZE_OPTIONS = { disallowedSpecial: new Set<string>() };

export function estimateTokens(text: string, mode: TokenizerMode = "o200k_base"): number {
  if (mode === "bytes4") {
    const bytes = Buffer.byteLength(text, "utf8");
    return Math.ceil(bytes / 4);
  }
  return countO200kTokens(text, SAFE_TOKENIZE_OPTIONS);
}

export function runContextChecks(
  tools: McpTool[],
  promptCount: number = 0,
  resourceCount: number = 0,
  tokenizer: TokenizerMode = "o200k_base",
): {
  context: ContextBudgetSummary;
  checks: CheckResult[];
} {
  const entries: ToolTokenEntry[] = tools.map((tool) => {
    const serialized = JSON.stringify(tool);
    const bytes = Buffer.byteLength(serialized, "utf8");
    const hasDescription = Boolean(tool.description && tool.description.trim().length > 0);
    const hasAnnotations = Boolean(tool.annotations && Object.keys(tool.annotations).length > 0);
    return {
      name: tool.name,
      bytes,
      estimatedTokens: estimateTokens(serialized, tokenizer),
      hasDescription,
      hasAnnotations,
    };
  });

  const serializedCatalog = tools.length > 0 ? JSON.stringify(tools) : "";
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const estimatedTokens =
    tools.length === 0
      ? 0
      : tokenizer === "bytes4"
        ? Math.ceil(totalBytes / 4)
        : estimateTokens(serializedCatalog, tokenizer);
  const missingDescriptions = entries.filter((e) => !e.hasDescription).length;
  const missingAnnotations = entries.filter((e) => !e.hasAnnotations).length;
  const heaviestTools = [...entries].sort((a, b) => b.estimatedTokens - a.estimatedTokens || b.bytes - a.bytes).slice(0, 5);
  const tokenUnitLabel = tokenizer === "o200k_base" ? "o200k_base tokens" : "est. tokens (bytes/4)";
  const tokenPrefix = tokenizer === "o200k_base" ? "" : "~";

  const checks: CheckResult[] = [];

  // 1. Total context / token budget
  checks.push({
    id: "context.token-budget",
    category: "context",
    title: "Tool catalog context budget",
    status:
      tools.length === 0
        ? "skip"
        : estimatedTokens > FAIL_TOKEN_BUDGET
          ? "fail"
          : estimatedTokens > WARN_TOKEN_BUDGET
            ? "warn"
            : "pass",
    summary:
      tools.length === 0
        ? "No tools exposed."
        : `${tools.length} tool(s), ${(totalBytes / 1024).toFixed(1)} KiB (${tokenPrefix}${estimatedTokens.toLocaleString("en-US")} ${tokenUnitLabel} injected per turn).`,
    details: heaviestTools.map(
      (t) => `${t.name}: ${tokenPrefix}${t.estimatedTokens.toLocaleString("en-US")} ${tokenUnitLabel} (${t.bytes} bytes)`,
    ),
  });

  // 2. Descriptions completeness & bloat
  const oversized = tools.filter(
    (t) => typeof t.description === "string" && t.description.length > MAX_RECOMMENDED_DESC_CHARS,
  );
  checks.push({
    id: "context.tool-descriptions",
    category: "context",
    title: "Tool description quality",
    status:
      tools.length === 0
        ? "skip"
        : missingDescriptions > 0 || oversized.length > 0
          ? "warn"
          : "pass",
    summary:
      tools.length === 0
        ? "No tools exposed."
        : missingDescriptions === 0 && oversized.length === 0
          ? `All ${tools.length} tool(s) have concise non-empty descriptions.`
          : `${missingDescriptions} missing description(s), ${oversized.length} oversized (> ${MAX_RECOMMENDED_DESC_CHARS} chars).`,
    details: oversized
      .slice(0, 5)
      .map((t) => `${t.name}: ${t.description?.length ?? 0} chars`),
  });

  // 3. MCP tool safety annotations
  checks.push({
    id: "context.tool-annotations",
    category: "context",
    title: "MCP tool safety annotations",
    status: tools.length === 0 ? "skip" : missingAnnotations > 0 ? "warn" : "pass",
    summary:
      tools.length === 0
        ? "No tools exposed."
        : missingAnnotations === 0
          ? `All ${tools.length} tool(s) declare MCP safety annotations.`
          : `${missingAnnotations}/${tools.length} tool(s) omit readOnlyHint/destructiveHint annotations.`,
  });

  return {
    context: {
      tokenizer,
      toolCount: tools.length,
      promptCount,
      resourceCount,
      totalBytes,
      estimatedTokens,
      missingDescriptions,
      missingAnnotations,
      heaviestTools,
    },
    checks,
  };
}
