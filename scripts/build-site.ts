import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isValidAuditReport } from "../src/diff.js";
import type { ScorecardDocument } from "./run-scorecard.js";

const scorecardSrc = path.resolve("generated/scorecard.json");
const siteSrcDir = path.resolve("site");
const distSiteDir = path.resolve("dist-site");
const badgesDir = path.join(distSiteDir, "badges");

function gradeColor(grade: string): string {
  switch (grade) {
    case "A":
      return "brightgreen";
    case "B":
      return "yellowgreen";
    case "C":
      return "yellow";
    case "D":
      return "orange";
    default:
      return "red";
  }
}

await fs.rm(distSiteDir, { recursive: true, force: true });
await fs.mkdir(badgesDir, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js"]) {
  await fs.copyFile(path.join(siteSrcDir, file), path.join(distSiteDir, file));
}

const MAX_SCORECARD_BYTES = 10 * 1024 * 1024;
const scorecardStat = await fs.lstat(scorecardSrc);
if (scorecardStat.isSymbolicLink() || !scorecardStat.isFile()) {
  throw new Error("scorecard.json must be a regular file (symlinks are not allowed).");
}
if (scorecardStat.size > MAX_SCORECARD_BYTES) {
  throw new Error(`scorecard.json exceeds ${MAX_SCORECARD_BYTES}-byte limit (${scorecardStat.size} bytes).`);
}

const scorecardRaw = await fs.readFile(scorecardSrc, "utf8");
const parsed: unknown = JSON.parse(scorecardRaw);
if (
  !parsed ||
  typeof parsed !== "object" ||
  Array.isArray(parsed) ||
  (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
  (parsed as { tool?: unknown }).tool !== "mcp-probe" ||
  typeof (parsed as { generatedAt?: unknown }).generatedAt !== "string" ||
  !(parsed as { runner?: unknown }).runner ||
  typeof (parsed as { runner: { nodeVersion?: unknown } }).runner.nodeVersion !== "string" ||
  !Array.isArray((parsed as { entries?: unknown }).entries) ||
  !(parsed as { summary?: unknown }).summary ||
  typeof (parsed as { summary: Record<string, unknown> }).summary.servers !== "number" ||
  typeof (parsed as { summary: Record<string, unknown> }).summary.avgScore !== "number" ||
  typeof (parsed as { summary: Record<string, unknown> }).summary.passed !== "number" ||
  typeof (parsed as { summary: Record<string, unknown> }).summary.warned !== "number" ||
  typeof (parsed as { summary: Record<string, unknown> }).summary.failed !== "number" ||
  typeof (parsed as { summary: Record<string, unknown> }).summary.errors !== "number" ||
  typeof (parsed as { summary: Record<string, unknown> }).summary.totalTools !== "number"
) {
  throw new Error("Invalid scorecard.json structure.");
}
const doc = parsed as ScorecardDocument;

const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const seenIds = new Set<string>();
for (const entry of doc.entries) {
  if (!entry || typeof entry.id !== "string" || !SAFE_SLUG_REGEX.test(entry.id) || seenIds.has(entry.id)) {
    throw new Error(`Unsafe or duplicate scorecard entry id: "${String(entry?.id)}"`);
  }
  seenIds.add(entry.id);
  if (
    typeof entry.name !== "string" ||
    typeof entry.package !== "string" ||
    !isValidAuditReport(entry.report) ||
    !entry.report.target ||
    (entry.report.target.transport !== "http" && entry.report.target.transport !== "stdio") ||
    !entry.report.server ||
    typeof entry.report.server !== "object"
  ) {
    throw new Error(`Invalid report payload for scorecard entry "${entry.id}".`);
  }
}

await fs.writeFile(
  path.join(distSiteDir, "scorecard.json"),
  `${JSON.stringify(doc, null, 2)}\n`,
  "utf8",
);

const overallBadge = {
  schemaVersion: 1,
  label: "mcp-probe",
  message: `${doc.summary.servers} servers · avg ${doc.summary.avgScore}/100`,
  color: doc.summary.avgScore >= 85 ? "brightgreen" : doc.summary.avgScore >= 70 ? "yellow" : "orange",
};
await fs.writeFile(
  path.join(badgesDir, "overall.json"),
  `${JSON.stringify(overallBadge, null, 2)}\n`,
  "utf8",
);

for (const entry of doc.entries) {
  const badge = {
    schemaVersion: 1,
    label: entry.id,
    message: `Grade ${entry.report.grade} · ${entry.report.score}/100`,
    color: gradeColor(entry.report.grade),
  };
  await fs.writeFile(
    path.join(badgesDir, `${entry.id}.json`),
    `${JSON.stringify(badge, null, 2)}\n`,
    "utf8",
  );
}

await fs.writeFile(path.join(distSiteDir, ".nojekyll"), "", "utf8");

console.log(
  `Built static MCP scorecard site into ${distSiteDir} (${doc.entries.length + 1} Shields badge JSON files).`,
);
