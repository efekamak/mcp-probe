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

const scorecardRaw = await fs.readFile(scorecardSrc, "utf8");
await fs.writeFile(path.join(distSiteDir, "scorecard.json"), scorecardRaw, "utf8");

const doc = JSON.parse(scorecardRaw) as ScorecardDocument;

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

console.log(
  `Built static MCP scorecard site into ${distSiteDir} (${doc.entries.length + 1} Shields badge JSON files).`,
);
