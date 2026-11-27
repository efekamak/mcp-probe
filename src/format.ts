import type { AuditDiff } from "./diff.js";
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

function formatTokenText(report: AuditReport): string {
  const count = report.context.estimatedTokens.toLocaleString("en-US");
  return report.context.tokenizer === "bytes4"
    ? `~${count} est. tokens`
    : `${count} o200k_base tokens`;
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
    `Transport: ${report.target.transport}  |  Protocol: ${report.server.protocolVersion ?? "n/a"}  |  Tools: ${report.context.toolCount} (${formatTokenText(report)})`,
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
    `<tr><th>Tools &amp; Context</th><td>${report.context.toolCount} tools (${escapeHtml(formatTokenText(report))}, ${(report.context.totalBytes / 1024).toFixed(1)} KiB)</td></tr>`,
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

function signedDelta(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function formatTerminalDiff(diff: AuditDiff): string {
  const lines: string[] = [];
  const verdict = diff.regression ? "REGRESSION" : "OK";
  const reasonNote = diff.reasons.length > 0 ? ` (${diff.reasons.join(", ")})` : "";
  lines.push(
    `mcp-probe diff v${diff.toolVersion}  |  ${verdict}${reasonNote}`,
  );
  lines.push(
    `Score: ${diff.base.score} (${diff.base.grade}) -> ${diff.head.score} (${diff.head.grade}) [${signedDelta(diff.scoreDelta)}]  |  Tools: ${signedDelta(diff.toolCountDelta)}  |  Tokens: ${signedDelta(diff.estimatedTokensDelta)}${diff.tokenDeltaComparable ? "" : " (tokenizer mismatch)"}  |  Bytes: ${signedDelta(diff.bytesDelta)}`,
  );
  lines.push("");

  const totalToolChanges =
    diff.tools.added.length + diff.tools.removed.length + diff.tools.modified.length;
  if (totalToolChanges > 0) {
    lines.push("Tool changes:");
    for (const t of diff.tools.added) {
      lines.push(`  [+ADD] ${t.name} (${signedDelta(t.tokenDelta)} tokens)`);
    }
    for (const t of diff.tools.removed) {
      lines.push(`  [-DEL] ${t.name} (${signedDelta(t.tokenDelta)} tokens)`);
    }
    for (const t of diff.tools.modified) {
      lines.push(`  [~MOD] ${t.name} (${t.baseTokens} -> ${t.headTokens} tokens, ${signedDelta(t.tokenDelta)})`);
    }
    lines.push("");
  } else if (diff.toolInventory === "partial" && diff.toolCountDelta !== 0) {
    lines.push("Tool changes: partial inventory (legacy report lacks full tool list).");
    lines.push("");
  }

  if (diff.newFailures.length > 0) {
    lines.push("New failures:");
    for (const c of diff.newFailures) {
      lines.push(`  [FAIL] ${c.id} (${c.baseStatus ?? "new"} -> ${c.headStatus}): ${c.summary}`);
    }
    lines.push("");
  }

  if (diff.newProviderErrors.length > 0) {
    lines.push("New provider errors:");
    for (const p of diff.newProviderErrors) {
      lines.push(`  [FAIL] ${p.provider} / ${p.tool}${p.path ? ` (${p.path})` : ""}: ${p.message}`);
    }
    lines.push("");
  }

  if (diff.newSafetyErrors.length > 0) {
    lines.push("New safety errors:");
    for (const s of diff.newSafetyErrors) {
      lines.push(`  [FAIL] ${s.tool ?? "(server)"} [${s.rule}]: ${s.message}`);
    }
    lines.push("");
  }

  if (diff.breakingToolChanges.length > 0) {
    lines.push("Breaking tool schema changes:");
    for (const b of diff.breakingToolChanges) {
      const parts: string[] = [];
      if (b.addedRequiredParams.length > 0) {
        parts.push(`+required: ${b.addedRequiredParams.join(", ")}`);
      }
      if (b.removedParams.length > 0) {
        parts.push(`-param: ${b.removedParams.join(", ")}`);
      }
      lines.push(`  [FAIL] ${b.tool} (${parts.join("; ")})`);
    }
    lines.push("");
  }

  if (diff.resolvedFailures.length > 0) {
    lines.push("Resolved failures:");
    for (const c of diff.resolvedFailures) {
      lines.push(`  [PASS] ${c.id} (${c.baseStatus ?? "fail"} -> ${c.headStatus})`);
    }
    lines.push("");
  }

  if (diff.newWarnings.length > 0) {
    lines.push("New warnings:");
    for (const c of diff.newWarnings) {
      lines.push(`  [WARN] ${c.id}: ${c.summary}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatMarkdownDiff(diff: AuditDiff): string {
  const verdict = diff.regression ? "REGRESSION" : "OK";
  const lines: string[] = [
    `<h3>mcp-probe diff: ${escapeHtml(verdict)}${diff.reasons.length > 0 ? ` (${escapeHtml(diff.reasons.join(", "))})` : ""}</h3>`,
    "<table><tbody>",
    `<tr><th>Score</th><td>${diff.base.score} (${escapeHtml(diff.base.grade)}) &rarr; ${diff.head.score} (${escapeHtml(diff.head.grade)}) (<code>${escapeHtml(signedDelta(diff.scoreDelta))}</code>)</td></tr>`,
    `<tr><th>Tools</th><td><code>${escapeHtml(signedDelta(diff.toolCountDelta))}</code></td></tr>`,
    `<tr><th>Tokens</th><td><code>${escapeHtml(signedDelta(diff.estimatedTokensDelta))}</code>${diff.tokenDeltaComparable ? "" : " (tokenizer mismatch)"}</td></tr>`,
    `<tr><th>Bytes</th><td><code>${escapeHtml(signedDelta(diff.bytesDelta))}</code></td></tr>`,
    "</tbody></table>",
  ];

  const allTools = [...diff.tools.added, ...diff.tools.modified, ...diff.tools.removed];
  if (allTools.length > 0) {
    lines.push("<h4>Tool changes</h4>");
    lines.push("<table><thead><tr><th>Change</th><th>Tool</th><th>Token delta</th></tr></thead><tbody>");
    for (const t of allTools) {
      lines.push(
        `<tr><td><code>${escapeHtml(t.change)}</code></td><td><code>${escapeHtml(t.name)}</code></td><td><code>${escapeHtml(signedDelta(t.tokenDelta))}</code></td></tr>`,
      );
    }
    lines.push("</tbody></table>");
  }

  if (diff.newFailures.length > 0) {
    lines.push("<h4>New failures</h4><ul>");
    for (const c of diff.newFailures) {
      lines.push(
        `<li><strong>${escapeHtml(c.id)}:</strong> <code>${escapeHtml(c.summary)}</code></li>`,
      );
    }
    lines.push("</ul>");
  }

  if (diff.newProviderErrors.length > 0) {
    lines.push("<h4>New provider errors</h4><ul>");
    for (const p of diff.newProviderErrors) {
      lines.push(
        `<li><strong>${escapeHtml(p.provider)} / ${escapeHtml(p.tool)}:</strong> <code>${escapeHtml(p.message)}</code></li>`,
      );
    }
    lines.push("</ul>");
  }

  if (diff.newSafetyErrors.length > 0) {
    lines.push("<h4>New safety errors</h4><ul>");
    for (const s of diff.newSafetyErrors) {
      lines.push(
        `<li><strong>${escapeHtml(s.tool ?? "(server)")} (${escapeHtml(s.rule)}):</strong> <code>${escapeHtml(s.message)}</code></li>`,
      );
    }
    lines.push("</ul>");
  }

  if (diff.breakingToolChanges.length > 0) {
    lines.push("<h4>Breaking tool schema changes</h4><ul>");
    for (const b of diff.breakingToolChanges) {
      const parts: string[] = [];
      if (b.addedRequiredParams.length > 0) {
        parts.push(`+required: ${b.addedRequiredParams.join(", ")}`);
      }
      if (b.removedParams.length > 0) {
        parts.push(`-param: ${b.removedParams.join(", ")}`);
      }
      lines.push(
        `<li><strong>${escapeHtml(b.tool)}:</strong> <code>${escapeHtml(parts.join("; "))}</code></li>`,
      );
    }
    lines.push("</ul>");
  }

  if (diff.resolvedFailures.length > 0) {
    lines.push("<h4>Resolved failures</h4><ul>");
    for (const c of diff.resolvedFailures) {
      lines.push(`<li><code>${escapeHtml(c.id)}</code></li>`);
    }
    lines.push("</ul>");
  }

  return `${lines.join("\n")}\n`;
}
