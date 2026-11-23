import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as core from "@actions/core";
import { formatMarkdownSummary } from "../src/format.js";
import { probeMcpServer } from "../src/runner.js";
import { scrubText } from "../src/sanitize.js";
import { toSarifReport } from "../src/sarif.js";
import type { ProbeTarget } from "../src/types.js";

function parseArgsInput(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      throw new Error("args JSON must be an array of strings.");
    }
    return parsed;
  }
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error("Unterminated quote in args input.");
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

async function resolveWorkingDir(workspaceDir: string, workingDirInput: string): Promise<string> {
  if (workspaceDir.includes("\0") || workingDirInput.includes("\0")) {
    throw new Error("working-directory must not contain null bytes.");
  }
  const trimmed = workingDirInput.trim();
  const cleaned =
    trimmed === "" || trimmed === "." || trimmed === "./" || trimmed === ".\\"
      ? "."
      : trimmed.replace(/^(?:\.\/|\.\\)+/, "").replace(/[\\/]+$/, "") || ".";
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) {
    throw new Error("working-directory must be a relative path inside GITHUB_WORKSPACE.");
  }
  const resolvedBase = path.resolve(workspaceDir);
  const resolvedTarget = path.resolve(resolvedBase, cleaned);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("working-directory escapes GITHUB_WORKSPACE.");
  }
  const [realBase, realTarget] = await Promise.all([
    fs.realpath(resolvedBase),
    fs.realpath(resolvedTarget),
  ]);
  const realRel = path.relative(realBase, realTarget);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error("working-directory symlink escapes GITHUB_WORKSPACE.");
  }
  const targetStat = await fs.stat(realTarget);
  if (!targetStat.isDirectory()) {
    throw new Error("working-directory must point to an existing directory.");
  }
  return realTarget;
}

async function writeArtifactFile(runnerTemp: string, ext: "json" | "sarif", text: string): Promise<string> {
  const dir = path.join(path.resolve(runnerTemp), "mcp-probe");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Refusing to write into non-directory or symlinked RUNNER_TEMP/mcp-probe path.");
  }
  const filePath = path.join(dir, `${crypto.randomUUID()}.${ext}`);
  await fs.writeFile(filePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return filePath;
}

export async function run(): Promise<void> {
  try {
    const command = core.getInput("command").trim();
    const argsRaw = core.getInput("args");
    const httpUrl = core.getInput("http-url").trim();
    const workingDirInput = core.getInput("working-directory");
    const timeoutRaw = core.getInput("timeout-ms").trim() || "15000";
    const failOn = (core.getInput("fail-on").trim() || "fail").toLowerCase();

    if (!["fail", "warn", "none"].includes(failOn)) {
      throw new Error(`Invalid fail-on value "${failOn}" (expected fail, warn, or none).`);
    }

    const timeoutMs = Number.parseInt(timeoutRaw, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000) {
      throw new Error("timeout-ms must be an integer between 500 and 120000.");
    }

    if ((command.length === 0 && httpUrl.length === 0) || (command.length > 0 && httpUrl.length > 0)) {
      throw new Error("Specify exactly one of 'command' (stdio) or 'http-url' (Streamable HTTP).");
    }

    const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
    const runnerTemp = process.env.RUNNER_TEMP || "";

    let target: ProbeTarget;
    if (httpUrl.length > 0) {
      target = { transport: "http", url: httpUrl };
    } else {
      const cwd = await resolveWorkingDir(workspaceDir, workingDirInput);
      target = {
        transport: "stdio",
        command,
        args: parseArgsInput(argsRaw),
        cwd,
      };
    }

    const report = await probeMcpServer(target, {
      stepTimeoutMs: timeoutMs,
      failOnWarn: failOn === "warn",
    });

    let resultPath = "";
    let sarifPath = "";
    if (runnerTemp.length > 0) {
      resultPath = await writeArtifactFile(runnerTemp, "json", `${JSON.stringify(report, null, 2)}\n`);
      sarifPath = await writeArtifactFile(
        runnerTemp,
        "sarif",
        `${JSON.stringify(toSarifReport(report), null, 2)}\n`,
      );
    }

    core.setOutput("status", report.status);
    core.setOutput("score", String(report.score));
    core.setOutput("grade", report.grade);
    core.setOutput("tool-count", String(report.context.toolCount));
    core.setOutput("estimated-tokens", String(report.context.estimatedTokens));
    core.setOutput("failed-checks", String(report.counts.fail));
    core.setOutput("result-path", resultPath);
    core.setOutput("sarif-path", sarifPath);

    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        await core.summary.addRaw(formatMarkdownSummary(report)).write();
      } catch {
        core.warning("Could not write GitHub Step Summary.");
      }
    }

    if (report.status === "error") {
      core.setFailed(`mcp-probe error: ${report.fatalError ?? "could not audit MCP server"}`);
    } else if (failOn === "fail" && report.status === "failed") {
      core.setFailed(
        `mcp-probe failed (Grade ${report.grade}, ${report.score}/100, ${report.counts.fail} failed check(s)).`,
      );
    } else if (failOn === "warn" && (report.status === "failed" || report.status === "warned")) {
      core.setFailed(
        `mcp-probe did not pass cleanly under fail-on=warn (Grade ${report.grade}, ${report.score}/100).`,
      );
    } else {
      core.info(
        `mcp-probe ${report.status}: Grade ${report.grade} (${report.score}/100), ${report.context.toolCount} tools`,
      );
    }
  } catch (err) {
    const msg = scrubText(err instanceof Error ? err.message : String(err), 300);
    core.setOutput("status", "error");
    core.setOutput("score", "0");
    core.setOutput("grade", "F");
    core.setOutput("tool-count", "0");
    core.setOutput("estimated-tokens", "0");
    core.setOutput("failed-checks", "0");
    core.setOutput("result-path", "");
    core.setOutput("sarif-path", "");
    core.setFailed(`mcp-probe error: ${msg}`);
  }
}

void run();
