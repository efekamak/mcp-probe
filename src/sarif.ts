import type { AuditReport } from "./types.js";

export type SarifLog = {
  $schema: string;
  version: "2.1.0";
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: Array<{
          id: string;
          shortDescription: { text: string };
          defaultConfiguration: { level: "error" | "warning" | "note" };
        }>;
      };
    };
    results: Array<{
      ruleId: string;
      level: "error" | "warning" | "note";
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
        };
      }>;
    }>;
  }>;
};

function toSafeArtifactUri(report: AuditReport): string {
  if (report.server.name) {
    return `mcp://${encodeURIComponent(report.server.name)}`;
  }
  if (report.target.transport === "http") {
    try {
      return new URL(report.target.display).href;
    } catch {
      return "mcp://server";
    }
  }
  return report.target.display
    ? `mcp://${encodeURIComponent(report.target.display.slice(0, 120))}`
    : "mcp://server";
}

export function toSarifReport(report: AuditReport): SarifLog {
  const rulesMap = new Map<
    string,
    { id: string; shortDescription: { text: string }; defaultConfiguration: { level: "error" | "warning" | "note" } }
  >();
  const results: SarifLog["runs"][0]["results"] = [];
  const artifactUri = toSafeArtifactUri(report);

  for (const check of report.checks) {
    if (check.status !== "fail" && check.status !== "warn") continue;
    const level: "error" | "warning" = check.status === "fail" ? "error" : "warning";
    if (!rulesMap.has(check.id)) {
      rulesMap.set(check.id, {
        id: check.id,
        shortDescription: { text: check.title },
        defaultConfiguration: { level },
      });
    }
    const detailText =
      check.details && check.details.length > 0
        ? `${check.summary} Details: ${check.details.slice(0, 3).join("; ")}`
        : check.summary;
    results.push({
      ruleId: check.id,
      level,
      message: { text: detailText },
      locations: [{ physicalLocation: { artifactLocation: { uri: artifactUri } } }],
    });
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "mcp-probe",
            version: report.toolVersion,
            informationUri: "https://github.com/efekamak/mcp-probe",
            rules: [...rulesMap.values()],
          },
        },
        results,
      },
    ],
  };
}
