import { runContextChecks } from "./checks/context.js";
import { runProtocolChecks } from "./checks/protocol.js";
import { runSafetyChecks } from "./checks/safety.js";
import { runSchemaChecks } from "./checks/schema.js";
import { scrubText } from "./sanitize.js";
import { HttpProbeTransport } from "./transports/http.js";
import { StdioProbeTransport } from "./transports/stdio.js";
import type { ProbeTransport } from "./transports/types.js";
import type {
  AuditReport,
  CheckResult,
  Grade,
  ProbeOptions,
  ProbeTarget,
  ProviderCompatibility,
  ProviderId,
} from "./types.js";

export const TOOL_VERSION = "0.1.0";

function computeScoreAndGrade(checks: CheckResult[], connected: boolean): {
  score: number;
  grade: Grade;
} {
  if (!connected) {
    return { score: 0, grade: "F" };
  }
  let score = 100;
  for (const check of checks) {
    if (check.status === "fail") {
      score -= check.category === "safety" ? 25 : check.category === "protocol" ? 15 : 12;
    } else if (check.status === "warn") {
      score -= 4;
    }
  }
  score = Math.max(0, Math.min(100, score));
  const grade: Grade =
    score >= 92 ? "A" : score >= 80 ? "B" : score >= 68 ? "C" : score >= 50 ? "D" : "F";
  return { score, grade };
}

function emptyProviders(): Record<ProviderId, ProviderCompatibility> {
  const make = (provider: ProviderId): ProviderCompatibility => ({
    provider,
    compatible: false,
    compatibleTools: 0,
    totalTools: 0,
    errors: 0,
    warnings: 0,
    issues: [],
  });
  return {
    openai: make("openai"),
    anthropic: make("anthropic"),
    gemini: make("gemini"),
    cursor: make("cursor"),
  };
}

function formatTargetDisplay(target: ProbeTarget): string {
  if (target.transport === "http") {
    return scrubText(target.url, 200);
  }
  return scrubText([target.command, ...target.args].join(" "), 200);
}

export async function probeMcpServer(
  target: ProbeTarget,
  options: ProbeOptions = {},
): Promise<AuditReport> {
  const startedMs = Date.now();
  const timestamp = new Date(startedMs).toISOString();
  const stepTimeoutMs = options.stepTimeoutMs ?? 15_000;

  const transport: ProbeTransport =
    target.transport === "http"
      ? new HttpProbeTransport(target)
      : new StdioProbeTransport(target);

  try {
    const protocol = await runProtocolChecks(transport, stepTimeoutMs);

    if (!protocol.connected) {
      const counts = {
        pass: protocol.checks.filter((c) => c.status === "pass").length,
        warn: protocol.checks.filter((c) => c.status === "warn").length,
        fail: protocol.checks.filter((c) => c.status === "fail").length,
        skip: protocol.checks.filter((c) => c.status === "skip").length,
      };
      return {
        schemaVersion: 1,
        tool: "mcp-probe",
        toolVersion: TOOL_VERSION,
        timestamp,
        durationMs: Date.now() - startedMs,
        target: {
          transport: target.transport,
          display: formatTargetDisplay(target),
        },
        server: protocol.server,
        score: 0,
        grade: "F",
        status: "error",
        counts,
        checks: protocol.checks,
        providers: emptyProviders(),
        context: {
          toolCount: 0,
          totalBytes: 0,
          estimatedTokens: 0,
          missingDescriptions: 0,
          missingAnnotations: 0,
          heaviestTools: [],
        },
        safety: {
          passed: true,
          errors: 0,
          warnings: 0,
          findings: [],
        },
        fatalError: protocol.fatalError,
      };
    }

    const schema = runSchemaChecks(protocol.tools);
    const context = runContextChecks(protocol.tools);
    const safety = runSafetyChecks(protocol.tools, protocol.rawErrorBodies);

    const checks: CheckResult[] = [
      ...protocol.checks,
      ...schema.checks,
      ...context.checks,
      ...safety.checks,
    ];

    const counts = {
      pass: checks.filter((c) => c.status === "pass").length,
      warn: checks.filter((c) => c.status === "warn").length,
      fail: checks.filter((c) => c.status === "fail").length,
      skip: checks.filter((c) => c.status === "skip").length,
    };

    const { score, grade } = computeScoreAndGrade(checks, true);
    const status =
      counts.fail > 0 ? "failed" : counts.warn > 0 ? "warned" : "passed";

    return {
      schemaVersion: 1,
      tool: "mcp-probe",
      toolVersion: TOOL_VERSION,
      timestamp,
      durationMs: Date.now() - startedMs,
      target: {
        transport: target.transport,
        display: formatTargetDisplay(target),
      },
      server: protocol.server,
      score,
      grade,
      status,
      counts,
      checks,
      providers: schema.providers,
      context: context.context,
      safety: safety.safety,
      fatalError: null,
    };
  } finally {
    await transport.close();
  }
}
