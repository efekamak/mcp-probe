import type { AuditReport, CheckStatus, ProviderId } from "./types.js";

function statusTag(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return "[PASS]";
    case "warn":
      return "[WARN]";
    case "fail":
      return "[FAIL]";
    case "skip":
      return "[SKIP]";
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatTerminalReport(report: AuditReport): string {
  const lines: string[] = [];
  const serverLabel = report.server.name
    ? `${report.server.name}${report.server.version ? `@${report.server.version}` : ""}`
    : report.target.display;

  lines.push(`mcp-probe v${report.toolVersion}  |  ${serverLabel}`);
  lines.push(
    `Score: ${report.score}/100 (Grade ${report.grade})  |  Status: ${report.status.toUpperCase()}  |  ${report.durationMs}ms`,
  );
  lines.push(
    `Transport: ${report.target.transport}  |  Protocol: ${report.server.protocolVersion ?? "n/a"}  |  Tools: ${report.context.toolCount} (~${report.context.estimatedTokens.toLocaleString("en-US")} est. tokens)`,
  );
  lines.push("");

  if (report.fatalError) {
    lines.push(`Fatal error: ${report.fatalError}`);
    lines.push("");
  }

  lines.push("Provider compatibility:");
  for (const id of ["openai", "anthropic", "gemini", "cursor"] as ProviderId[]) {
    const p = report.providers[id];
    const badge = p.compatible ? (p.warnings > 0 ? "WARN" : "PASS") : "FAIL";
    lines.push(
      `  ${id.padEnd(10)} ${badge.padEnd(5)} ${p.compatibleTools}/${p.totalTools} tools (${p.errors} errors, ${p.warnings} warnings)`,
    );
  }
  lines.push("");

  lines.push("Checks:");
  for (const check of report.checks) {
    lines.push(`  ${statusTag(check.status)} ${check.title}`);
    lines.push(`         ${check.summary}`);
    if (check.details && check.details.length > 0) {
      for (const detail of check.details.slice(0, 4)) {
        lines.push(`           - ${detail}`);
      }
    }
  }

  lines.push("");
  lines.push(
    `Summary: ${report.counts.pass} passed, ${report.counts.warn} warned, ${report.counts.fail} failed, ${report.counts.skip} skipped`,
  );
  return `${lines.join("\n")}\n`;
}

export function formatMarkdownSummary(report: AuditReport): string {
  const serverLabel = report.server.name
    ? `${report.server.name}${report.server.version ? `@${report.server.version}` : ""}`
    : report.target.display;

  const lines: string[] = [
    `<h3>mcp-probe: ${escapeHtml(report.status)} (Grade ${escapeHtml(report.grade)} · ${report.score}/100)</h3>`,
    "<table><tbody>",
    `<tr><th>Server</th><td><code>${escapeHtml(serverLabel)}</code></td></tr>`,
    `<tr><th>Transport</th><td><code>${escapeHtml(report.target.transport)}</code></td></tr>`,
    `<tr><th>Protocol</th><td><code>${escapeHtml(report.server.protocolVersion ?? "n/a")}</code></td></tr>`,
    `<tr><th>Tools &amp; Context</th><td>${report.context.toolCount} tools (~${report.context.estimatedTokens.toLocaleString("en-US")} est. tokens, ${(report.context.totalBytes / 1024).toFixed(1)} KiB)</td></tr>`,
    `<tr><th>Duration</th><td>${report.durationMs} ms</td></tr>`,
    "</tbody></table>",
  ];

  if (report.fatalError) {
    lines.push(`<p><strong>Fatal error:</strong> <code>${escapeHtml(report.fatalError)}</code></p>`);
    return `${lines.join("\n")}\n`;
  }

  lines.push("<h4>Provider compatibility</h4>");
  lines.push(
    "<table><thead><tr><th>Provider</th><th>Status</th><th>Compatible tools</th><th>Errors</th><th>Warnings</th></tr></thead><tbody>",
  );
  for (const id of ["openai", "anthropic", "gemini", "cursor"] as ProviderId[]) {
    const p = report.providers[id];
    const badge = p.compatible ? (p.warnings > 0 ? "warn" : "pass") : "fail";
    lines.push(
      `<tr><td><code>${id}</code></td><td>${badge}</td><td>${p.compatibleTools}/${p.totalTools}</td><td>${p.errors}</td><td>${p.warnings}</td></tr>`,
    );
  }
  lines.push("</tbody></table>");

  lines.push("<h4>Checks</h4>");
  lines.push(
    "<table><thead><tr><th>Status</th><th>Check</th><th>Summary</th></tr></thead><tbody>",
  );
  for (const check of report.checks) {
    lines.push(
      `<tr><td><code>${escapeHtml(check.status)}</code></td><td>${escapeHtml(check.title)}</td><td>${escapeHtml(check.summary)}</td></tr>`,
    );
  }
  lines.push("</tbody></table>");

  const nonPass = report.checks.filter((c) => (c.status === "fail" || c.status === "warn") && c.details && c.details.length > 0);
  if (nonPass.length > 0) {
    lines.push("<h4>Findings</h4><ul>");
    for (const check of nonPass) {
      for (const detail of (check.details ?? []).slice(0, 5)) {
        lines.push(`<li><strong>${escapeHtml(check.id)}:</strong> <code>${escapeHtml(detail)}</code></li>`);
      }
    }
    lines.push("</ul>");
  }

  return `${lines.join("\n")}\n`;
}
