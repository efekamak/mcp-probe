import type {
  AuditReport,
  CheckStatus,
  Grade,
  ProviderId,
  ToolTokenEntry,
} from "./types.js";
import { TOOL_VERSION } from "./version.js";

export type DiffReason =
  | "score-drop"
  | "new-failure"
  | "new-safety-error"
  | "new-provider-error"
  | "token-delta"
  | "head-error";

export type ToolDelta = {
  name: string;
  change: "added" | "removed" | "modified";
  baseTokens: number | null;
  headTokens: number | null;
  tokenDelta: number;
  baseBytes: number | null;
  headBytes: number | null;
};

export type CheckDelta = {
  id: string;
  title: string;
  baseStatus: CheckStatus | null;
  headStatus: CheckStatus;
  summary: string;
};

export type ProviderDelta = {
  provider: ProviderId;
  tool: string;
  rule: string;
  path?: string;
  message: string;
};

export type SafetyDelta = {
  tool: string | null;
  rule: string;
  message: string;
};

export type AuditDiff = {
  schemaVersion: 1;
  tool: "mcp-probe-diff";
  toolVersion: string;
  regression: boolean;
  reasons: DiffReason[];
  scoreDelta: number;
  gradeChanged: boolean;
  base: { score: number; grade: Grade; status: AuditReport["status"] };
  head: { score: number; grade: Grade; status: AuditReport["status"] };
  estimatedTokensDelta: number;
  bytesDelta: number;
  toolCountDelta: number;
  tokenDeltaComparable: boolean;
  toolInventory: "full" | "partial";
  tools: {
    added: ToolDelta[];
    removed: ToolDelta[];
    modified: ToolDelta[];
  };
  newFailures: CheckDelta[];
  resolvedFailures: CheckDelta[];
  newWarnings: CheckDelta[];
  newProviderErrors: ProviderDelta[];
  resolvedProviderErrors: ProviderDelta[];
  newSafetyErrors: SafetyDelta[];
  resolvedSafetyErrors: SafetyDelta[];
};

const VALID_GRADES = new Set<string>(["A", "B", "C", "D", "F"]);
const VALID_STATUSES = new Set<string>(["passed", "warned", "failed", "error"]);
const VALID_CHECK_STATUSES = new Set<string>(["pass", "warn", "fail", "skip"]);
const PROVIDER_IDS: readonly ProviderId[] = ["openai", "anthropic", "gemini", "cursor"];

export function isValidAuditReport(candidate: unknown): candidate is AuditReport {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const r = candidate as Record<string, unknown>;
  if (r.schemaVersion !== 1 || r.tool !== "mcp-probe") return false;
  if (typeof r.score !== "number" || !Number.isFinite(r.score)) return false;
  if (typeof r.grade !== "string" || !VALID_GRADES.has(r.grade)) return false;
  if (typeof r.status !== "string" || !VALID_STATUSES.has(r.status)) return false;

  if (!Array.isArray(r.checks)) return false;
  for (const chk of r.checks) {
    if (!chk || typeof chk !== "object" || Array.isArray(chk)) return false;
    const c = chk as Record<string, unknown>;
    if (typeof c.id !== "string" || typeof c.status !== "string" || !VALID_CHECK_STATUSES.has(c.status)) {
      return false;
    }
  }

  if (!r.providers || typeof r.providers !== "object" || Array.isArray(r.providers)) return false;
  const provs = r.providers as Record<string, unknown>;
  for (const id of PROVIDER_IDS) {
    const p = provs[id];
    if (!p || typeof p !== "object" || Array.isArray(p)) return false;
    if (!Array.isArray((p as Record<string, unknown>).issues)) return false;
  }

  if (!r.context || typeof r.context !== "object" || Array.isArray(r.context)) return false;
  const ctx = r.context as Record<string, unknown>;
  if (
    typeof ctx.toolCount !== "number" ||
    !Number.isFinite(ctx.toolCount) ||
    typeof ctx.totalBytes !== "number" ||
    !Number.isFinite(ctx.totalBytes) ||
    typeof ctx.estimatedTokens !== "number" ||
    !Number.isFinite(ctx.estimatedTokens) ||
    !Array.isArray(ctx.heaviestTools)
  ) {
    return false;
  }
  if (ctx.tools !== undefined && !Array.isArray(ctx.tools)) {
    return false;
  }

  if (!r.safety || typeof r.safety !== "object" || Array.isArray(r.safety)) return false;
  if (!Array.isArray((r.safety as Record<string, unknown>).findings)) return false;

  return true;
}

function toToolMap(entries: ToolTokenEntry[]): Map<string, ToolTokenEntry> {
  const map = new Map<string, ToolTokenEntry>();
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || map.has(entry.name)) continue;
    map.set(entry.name, entry);
  }
  return map;
}

function providerErrorKey(p: ProviderDelta): string {
  return `${p.provider}|${p.tool}|${p.rule}|${p.path ?? ""}`;
}

function collectProviderErrors(report: AuditReport): Map<string, ProviderDelta> {
  const map = new Map<string, ProviderDelta>();
  for (const provider of PROVIDER_IDS) {
    const compat = report.providers[provider];
    if (!compat || !Array.isArray(compat.issues)) continue;
    for (const issue of compat.issues) {
      if (!issue || issue.severity !== "fail") continue;
      const entry: ProviderDelta = {
        provider,
        tool: issue.tool,
        rule: issue.rule,
        ...(issue.path !== undefined ? { path: issue.path } : {}),
        message: issue.message,
      };
      const key = providerErrorKey(entry);
      if (!map.has(key)) map.set(key, entry);
    }
  }
  return map;
}

function safetyErrorKey(tool: string | null, rule: string, severity: string): string {
  return `${tool ?? ""}|${rule}|${severity}`;
}

function collectSafetyErrors(report: AuditReport): Map<string, SafetyDelta> {
  const map = new Map<string, SafetyDelta>();
  for (const f of report.safety.findings) {
    if (!f || f.severity !== "fail") continue;
    const key = safetyErrorKey(f.tool, f.rule, f.severity);
    if (!map.has(key)) {
      map.set(key, {
        tool: f.tool,
        rule: f.rule,
        message: f.message,
      });
    }
  }
  return map;
}

export function diffAuditReports(
  base: AuditReport,
  head: AuditReport,
  options?: { maxTokenDelta?: number },
): AuditDiff {
  const scoreDelta = head.score - base.score;
  const gradeChanged = head.grade !== base.grade;
  const estimatedTokensDelta = head.context.estimatedTokens - base.context.estimatedTokens;
  const bytesDelta = head.context.totalBytes - base.context.totalBytes;
  const toolCountDelta = head.context.toolCount - base.context.toolCount;

  const baseTok = base.context.tokenizer ?? "o200k_base";
  const headTok = head.context.tokenizer ?? "o200k_base";
  const tokenDeltaComparable = baseTok === headTok;

  // Checks comparison by check.id
  const baseChecks = new Map(base.checks.map((c) => [c.id, c]));
  const headChecks = new Map(head.checks.map((c) => [c.id, c]));

  const newFailures: CheckDelta[] = [];
  const resolvedFailures: CheckDelta[] = [];
  const newWarnings: CheckDelta[] = [];

  for (const [id, hc] of headChecks.entries()) {
    const bc = baseChecks.get(id);
    if (hc.status === "fail" && (!bc || bc.status !== "fail")) {
      newFailures.push({
        id,
        title: hc.title,
        baseStatus: bc?.status ?? null,
        headStatus: hc.status,
        summary: hc.summary,
      });
    }
    if (hc.status === "warn" && (!bc || bc.status !== "warn")) {
      newWarnings.push({
        id,
        title: hc.title,
        baseStatus: bc?.status ?? null,
        headStatus: hc.status,
        summary: hc.summary,
      });
    }
  }

  for (const [id, bc] of baseChecks.entries()) {
    const hc = headChecks.get(id);
    if (bc.status === "fail" && (!hc || hc.status !== "fail")) {
      resolvedFailures.push({
        id,
        title: hc?.title ?? bc.title,
        baseStatus: bc.status,
        headStatus: hc?.status ?? "skip",
        summary: hc?.summary ?? "Check no longer failing.",
      });
    }
  }

  newFailures.sort((a, b) => a.id.localeCompare(b.id));
  resolvedFailures.sort((a, b) => a.id.localeCompare(b.id));
  newWarnings.sort((a, b) => a.id.localeCompare(b.id));

  // Provider error comparison
  const baseProvErrors = collectProviderErrors(base);
  const headProvErrors = collectProviderErrors(head);

  const newProviderErrors: ProviderDelta[] = [];
  const resolvedProviderErrors: ProviderDelta[] = [];
  for (const [key, item] of headProvErrors.entries()) {
    if (!baseProvErrors.has(key)) newProviderErrors.push(item);
  }
  for (const [key, item] of baseProvErrors.entries()) {
    if (!headProvErrors.has(key)) resolvedProviderErrors.push(item);
  }
  newProviderErrors.sort((a, b) => providerErrorKey(a).localeCompare(providerErrorKey(b)));
  resolvedProviderErrors.sort((a, b) => providerErrorKey(a).localeCompare(providerErrorKey(b)));

  // Safety error comparison
  const baseSafetyErrors = collectSafetyErrors(base);
  const headSafetyErrors = collectSafetyErrors(head);

  const newSafetyErrors: SafetyDelta[] = [];
  const resolvedSafetyErrors: SafetyDelta[] = [];
  for (const [key, item] of headSafetyErrors.entries()) {
    if (!baseSafetyErrors.has(key)) newSafetyErrors.push(item);
  }
  for (const [key, item] of baseSafetyErrors.entries()) {
    if (!headSafetyErrors.has(key)) resolvedSafetyErrors.push(item);
  }
  const sortSafety = (a: SafetyDelta, b: SafetyDelta) =>
    `${a.tool ?? ""}|${a.rule}`.localeCompare(`${b.tool ?? ""}|${b.rule}`);
  newSafetyErrors.sort(sortSafety);
  resolvedSafetyErrors.sort(sortSafety);

  // Tool inventory comparison
  const hasFullInventory = Array.isArray(base.context.tools) && Array.isArray(head.context.tools);
  const toolInventory: "full" | "partial" = hasFullInventory ? "full" : "partial";
  const added: ToolDelta[] = [];
  const removed: ToolDelta[] = [];
  const modified: ToolDelta[] = [];

  if (hasFullInventory) {
    const baseTools = toToolMap(base.context.tools!);
    const headTools = toToolMap(head.context.tools!);

    for (const [name, ht] of headTools.entries()) {
      const bt = baseTools.get(name);
      if (!bt) {
        added.push({
          name,
          change: "added",
          baseTokens: null,
          headTokens: ht.estimatedTokens,
          tokenDelta: ht.estimatedTokens,
          baseBytes: null,
          headBytes: ht.bytes,
        });
      } else if (
        bt.estimatedTokens !== ht.estimatedTokens ||
        bt.bytes !== ht.bytes ||
        bt.hasDescription !== ht.hasDescription ||
        bt.hasAnnotations !== ht.hasAnnotations
      ) {
        modified.push({
          name,
          change: "modified",
          baseTokens: bt.estimatedTokens,
          headTokens: ht.estimatedTokens,
          tokenDelta: ht.estimatedTokens - bt.estimatedTokens,
          baseBytes: bt.bytes,
          headBytes: ht.bytes,
        });
      }
    }

    for (const [name, bt] of baseTools.entries()) {
      if (!headTools.has(name)) {
        removed.push({
          name,
          change: "removed",
          baseTokens: bt.estimatedTokens,
          headTokens: null,
          tokenDelta: -bt.estimatedTokens,
          baseBytes: bt.bytes,
          headBytes: null,
        });
      }
    }

    added.sort((a, b) => a.name.localeCompare(b.name));
    removed.sort((a, b) => a.name.localeCompare(b.name));
    modified.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Regression gating reasons
  const reasons: DiffReason[] = [];
  if (head.status === "error") reasons.push("head-error");
  if (scoreDelta < 0) reasons.push("score-drop");
  if (newFailures.length > 0) reasons.push("new-failure");
  if (newSafetyErrors.length > 0) reasons.push("new-safety-error");
  if (newProviderErrors.length > 0) reasons.push("new-provider-error");
  if (
    options?.maxTokenDelta !== undefined &&
    tokenDeltaComparable &&
    estimatedTokensDelta > options.maxTokenDelta
  ) {
    reasons.push("token-delta");
  }

  return {
    schemaVersion: 1,
    tool: "mcp-probe-diff",
    toolVersion: TOOL_VERSION,
    regression: reasons.length > 0,
    reasons,
    scoreDelta,
    gradeChanged,
    base: { score: base.score, grade: base.grade, status: base.status },
    head: { score: head.score, grade: head.grade, status: head.status },
    estimatedTokensDelta,
    bytesDelta,
    toolCountDelta,
    tokenDeltaComparable,
    toolInventory,
    tools: { added, removed, modified },
    newFailures,
    resolvedFailures,
    newWarnings,
    newProviderErrors,
    resolvedProviderErrors,
    newSafetyErrors,
    resolvedSafetyErrors,
  };
}
