import * as fs from "node:fs/promises";
import * as path from "node:path";

const scorecardSrc = path.resolve("generated/scorecard.json");
const siteSrcDir = path.resolve("site");
const distSiteDir = path.resolve("dist-site");

await fs.rm(distSiteDir, { recursive: true, force: true });
await fs.mkdir(distSiteDir, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js"]) {
  await fs.copyFile(path.join(siteSrcDir, file), path.join(distSiteDir, file));
}

await fs.copyFile(scorecardSrc, path.join(distSiteDir, "scorecard.json"));
console.log(`Built static MCP scorecard site into ${distSiteDir}`);
