import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { probeMcpServer, TOOL_VERSION } from "../src/runner.js";
import type { AuditReport, ProbeTarget } from "../src/types.js";

type CatalogStdioServer = {
  id: string;
  name: string;
  package: string;
  repositoryUrl?: string | null;
  transport: "stdio";
  command: string;
  args: string[];
};

type CatalogHttpServer = {
  id: string;
  name: string;
  package: string;
  repositoryUrl?: string | null;
  transport: "http";
  url: string;
};

type CatalogServer = CatalogStdioServer | CatalogHttpServer;

type CatalogFile = {
  schemaVersion: 1;
  servers: CatalogServer[];
};

export type ScorecardEntry = {
  id: string;
  name: string;
  package: string;
  repositoryUrl: string | null;
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
const resultsByIndex: Array<ScorecardEntry | undefined> = new Array(catalogRaw.servers.length);

const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function probeEntry(srv: CatalogServer): Promise<ScorecardEntry> {
  if (!SAFE_SLUG_REGEX.test(srv.id)) {
    throw new Error(`Unsafe catalog server id: "${srv.id}"`);
  }
  if (dryRun) {
    const display = srv.transport === "http" ? srv.url : [srv.command, ...srv.args].join(" ");
    const dummyReport: AuditReport = {
      schemaVersion: 1,
      tool: "mcp-probe",
      toolVersion: TOOL_VERSION,
      timestamp: new Date().toISOString(),
      durationMs: 0,
      target: { transport: srv.transport, display },
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
      context: {
        tokenizer: "o200k_base",
        toolCount: 0,
        promptCount: 0,
        resourceCount: 0,
        totalBytes: 0,
        estimatedTokens: 0,
        missingDescriptions: 0,
        missingAnnotations: 0,
        heaviestTools: [],
        tools: [],
      },
      safety: { passed: true, errors: 0, warnings: 0, findings: [] },
      fatalError: null,
    };
    return {
      id: srv.id,
      name: srv.name,
      package: srv.package,
      repositoryUrl: srv.repositoryUrl ?? null,
      report: dummyReport,
    };
  }

  let target: ProbeTarget;
  if (srv.transport === "http") {
    target = { transport: "http", url: srv.url };
  } else {
    const isolatedDir = path.join(tempRoot, srv.id);
    await fs.mkdir(isolatedDir, { recursive: true });
    target = {
      transport: "stdio",
      command: srv.command,
      args: srv.args.map((a) => (a === "__TEMP_DIR__" ? isolatedDir : a)),
      cwd: isolatedDir,
    };
  }

  console.log(`Probing [${srv.transport}] ${srv.name} (${srv.package})...`);
  let report: AuditReport;
  try {
    report = await probeMcpServer(target, { stepTimeoutMs: 30_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const display = srv.transport === "http" ? srv.url : [srv.command, ...srv.args].join(" ");
    report = {
      schemaVersion: 1,
      tool: "mcp-probe",
      toolVersion: TOOL_VERSION,
      timestamp: new Date().toISOString(),
      durationMs: 0,
      target: { transport: srv.transport, display },
      server: { name: null, version: null, protocolVersion: null, capabilities: [] },
      score: 0,
      grade: "F",
      status: "error",
      counts: { pass: 0, warn: 0, fail: 0, skip: 0 },
      checks: [],
      providers: {
        openai: { provider: "openai", compatible: false, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
        anthropic: { provider: "anthropic", compatible: false, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
        gemini: { provider: "gemini", compatible: false, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
        cursor: { provider: "cursor", compatible: false, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
      },
      context: {
        tokenizer: "o200k_base",
        toolCount: 0,
        promptCount: 0,
        resourceCount: 0,
        totalBytes: 0,
        estimatedTokens: 0,
        missingDescriptions: 0,
        missingAnnotations: 0,
        heaviestTools: [],
        tools: [],
      },
      safety: { passed: true, errors: 0, warnings: 0, findings: [] },
      fatalError: msg.slice(0, 300),
    };
  }

  console.log(
    `  -> ${srv.name}: ${report.status.toUpperCase()} Grade ${report.grade} (${report.score}/100) | ${report.context.toolCount} tools (~${report.context.estimatedTokens} tokens)`,
  );

  return {
    id: srv.id,
    name: srv.name,
    package: srv.package,
    repositoryUrl: srv.repositoryUrl ?? null,
    report,
  };
}

try {
  // Probe remote HTTP targets with bounded concurrency (4) while keeping stdio sequential
  // to avoid npx cache contention.
  const httpIndexed = catalogRaw.servers
    .map((srv, idx) => ({ srv, idx }))
    .filter((item) => item.srv.transport === "http");
  const stdioIndexed = catalogRaw.servers
    .map((srv, idx) => ({ srv, idx }))
    .filter((item) => item.srv.transport === "stdio");

  const HTTP_CONCURRENCY = 4;
  let httpCursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(HTTP_CONCURRENCY, httpIndexed.length) }, async () => {
      while (httpCursor < httpIndexed.length) {
        const current = httpIndexed[httpCursor++];
        resultsByIndex[current.idx] = await probeEntry(current.srv);
      }
    }),
  );

  for (const current of stdioIndexed) {
    resultsByIndex[current.idx] = await probeEntry(current.srv);
  }
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

const entries: ScorecardEntry[] = resultsByIndex.filter(
  (e): e is ScorecardEntry => e !== undefined,
);

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
