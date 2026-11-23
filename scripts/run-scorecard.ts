import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { probeMcpServer, TOOL_VERSION } from "../src/runner.js";
import type { AuditReport } from "../src/types.js";

type CatalogServer = {
  id: string;
  name: string;
  package: string;
  repositoryUrl: string;
  transport: "stdio";
  command: string;
  args: string[];
};

type CatalogFile = {
  schemaVersion: 1;
  servers: CatalogServer[];
};

export type ScorecardEntry = {
  id: string;
  name: string;
  package: string;
  repositoryUrl: string;
  report: AuditReport;
};

export type ScorecardDocument = {
  schemaVersion: 1;
  tool: "mcp-probe";
  toolVersion: string;
  generatedAt: string;
  sourceCommit: string | null;
  runner: {
    platform: string;
    nodeVersion: string;
  };
  summary: {
    servers: number;
    passed: number;
    warned: number;
    failed: number;
    errors: number;
    totalTools: number;
    avgScore: number;
  };
  entries: ScorecardEntry[];
};

const outArg = process.argv.find((a) => a.startsWith("--out="));
const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "generated/scorecard.json");
const dryRun = process.argv.includes("--dry-run");

const catalogRaw = JSON.parse(
  await fs.readFile(path.resolve("catalog/servers.json"), "utf8"),
) as CatalogFile;

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-probe-scorecard-"));
const entries: ScorecardEntry[] = [];

try {
  for (const srv of catalogRaw.servers) {
    if (dryRun) {
      const dummyReport: AuditReport = {
        schemaVersion: 1,
        tool: "mcp-probe",
        toolVersion: TOOL_VERSION,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        target: { transport: "stdio", display: [srv.command, ...srv.args].join(" ") },
        server: { name: srv.id, version: "0.0.0", protocolVersion: "2025-03-26", capabilities: ["tools"] },
        score: 100,
        grade: "A",
        status: "passed",
        counts: { pass: 1, warn: 0, fail: 0, skip: 0 },
        checks: [],
        providers: {
          openai: { provider: "openai", compatible: true, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
          anthropic: { provider: "anthropic", compatible: true, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
          gemini: { provider: "gemini", compatible: true, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
          cursor: { provider: "cursor", compatible: true, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
        },
        context: { toolCount: 0, totalBytes: 0, estimatedTokens: 0, missingDescriptions: 0, missingAnnotations: 0, heaviestTools: [] },
        safety: { passed: true, errors: 0, warnings: 0, findings: [] },
        fatalError: null,
      };
      entries.push({
        id: srv.id,
        name: srv.name,
        package: srv.package,
        repositoryUrl: srv.repositoryUrl,
        report: dummyReport,
      });
      continue;
    }

    const isolatedDir = path.join(tempRoot, srv.id);
    await fs.mkdir(isolatedDir, { recursive: true });
    const resolvedArgs = srv.args.map((a) => (a === "__TEMP_DIR__" ? isolatedDir : a));

    console.log(`Probing ${srv.name} (${srv.package})...`);
    const report = await probeMcpServer(
      {
        transport: "stdio",
        command: srv.command,
        args: resolvedArgs,
        cwd: isolatedDir,
      },
      { stepTimeoutMs: 30_000 },
    );

    console.log(
      `  -> ${report.status.toUpperCase()} Grade ${report.grade} (${report.score}/100) | ${report.context.toolCount} tools (~${report.context.estimatedTokens} tokens)`,
    );

    entries.push({
      id: srv.id,
      name: srv.name,
      package: srv.package,
      repositoryUrl: srv.repositoryUrl,
      report,
    });
  }
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

const totalScore = entries.reduce((sum, e) => sum + e.report.score, 0);
const doc: ScorecardDocument = {
  schemaVersion: 1,
  tool: "mcp-probe",
  toolVersion: TOOL_VERSION,
  generatedAt: new Date().toISOString(),
  sourceCommit: process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : null,
  runner: {
    platform: process.platform,
    nodeVersion: process.version,
  },
  summary: {
    servers: entries.length,
    passed: entries.filter((e) => e.report.status === "passed").length,
    warned: entries.filter((e) => e.report.status === "warned").length,
    failed: entries.filter((e) => e.report.status === "failed").length,
    errors: entries.filter((e) => e.report.status === "error").length,
    totalTools: entries.reduce((sum, e) => sum + e.report.context.toolCount, 0),
    avgScore: entries.length > 0 ? Math.round(totalScore / entries.length) : 0,
  },
  entries,
};

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`Wrote scorecard to ${outPath} (${entries.length} servers, avg ${doc.summary.avgScore}/100).`);
