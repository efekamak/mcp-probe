import * as fs from "node:fs/promises";
import * as path from "node:path";

const distDir = path.resolve("dist-action");
const requiredFiles = ["index.js", "licenses.txt", "package.json"];
const forbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "sourceMappingURL", pattern: /sourceMappingURL/ },
  { label: "CURSOR_API_KEY", pattern: /CURSOR_API_KEY/ },
  { label: "CURSOR_SERVICE_ACCOUNT_KEY", pattern: /CURSOR_SERVICE_ACCOUNT_KEY/ },
  { label: "Windows local user path", pattern: /[A-Za-z]:\\Users\\/i },
  { label: "Unix local home path", pattern: /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\// },
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
for (const { label, pattern } of forbiddenPatterns) {
  if (pattern.test(bundle)) {
    throw new Error(`Forbidden content found in dist-action/index.js: ${label}`);
  }
}

console.log(`Verified dist-action bundle (${Buffer.byteLength(bundle, "utf8")} bytes, 0 forbidden tokens).`);
