import * as fs from "node:fs/promises";
import * as path from "node:path";
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
  !Array.isArray((parsed as { entries?: unknown }).entries) ||
  !(parsed as { summary?: unknown }).summary ||
  typeof (parsed as { summary: { servers?: unknown; avgScore?: unknown } }).summary.servers !== "number" ||
  typeof (parsed as { summary: { servers?: unknown; avgScore?: unknown } }).summary.avgScore !== "number"
) {
  throw new Error("Invalid scorecard.json structure.");
}
const doc = parsed as ScorecardDocument;
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

const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

for (const entry of doc.entries) {
  if (!entry || typeof entry.id !== "string" || !SAFE_SLUG_REGEX.test(entry.id)) {
    throw new Error(`Unsafe badge entry id: "${String(entry?.id)}"`);
  }
  if (
    !entry.report ||
    typeof entry.report.grade !== "string" ||
    typeof entry.report.score !== "number" ||
    !Number.isFinite(entry.report.score)
  ) {
    throw new Error(`Invalid report payload for scorecard entry "${entry.id}".`);
  }
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
