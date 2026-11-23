import * as fs from "node:fs/promises";
import * as path from "node:path";

const distDir = path.resolve("dist-action");
const requiredFiles = ["index.js", "licenses.txt", "package.json"];
const forbiddenTokens = [
  "sourceMappingURL",
  "CURSOR_API_KEY",
  "CURSOR_SERVICE_ACCOUNT_KEY",
  "C:\\Users\\",
  "/Users/",
];

const entries = await fs.readdir(distDir);
for (const req of requiredFiles) {
  if (!entries.includes(req)) {
    throw new Error(`Missing required file in dist-action/: ${req}`);
  }
}
for (const entry of entries) {
  if (entry.endsWith(".map")) {
    throw new Error(`Unexpected source map in dist-action/: ${entry}`);
  }
}

const bundle = await fs.readFile(path.join(distDir, "index.js"), "utf8");
for (const token of forbiddenTokens) {
  if (bundle.includes(token)) {
    throw new Error(`Forbidden token found in dist-action/index.js: ${token}`);
  }
}

console.log(`Verified dist-action bundle (${Buffer.byteLength(bundle, "utf8")} bytes, 0 forbidden tokens).`);
