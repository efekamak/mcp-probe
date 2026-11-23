#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatMarkdownSummary, formatTerminalReport } from "./format.js";
import { probeMcpServer, TOOL_VERSION } from "./runner.js";
import type { ProbeTarget } from "./types.js";

function printHelp(): void {
  process.stdout.write(`mcp-probe v${TOOL_VERSION}

Deterministic conformance, cross-provider tool schema compatibility,
context budget, and tool-poisoning audit for MCP servers.

Usage:
  mcp-probe --stdio -- <command> [args...]
  mcp-probe --http <url> [options]

Options:
  --stdio                Connect to an MCP server over stdio (put command after --)
  --http <url>           Connect to a Streamable HTTP MCP endpoint
  --header "Key: Value"  Add an HTTP request header (repeatable)
  --env KEY=VALUE        Pass an explicit env var to a stdio server (repeatable)
  --cwd <dir>            Working directory for stdio server
  --timeout <ms>         Per-step timeout in ms (default: 15000)
  --json                 Print JSON report to stdout
  --markdown             Print HTML/Markdown summary to stdout
  --out <file>           Write JSON report to a file
  --strict               Exit 1 on warnings as well as failures
  -v, --version          Print version
  -h, --help             Show this help
`);
}

export type ParsedCliArgs = {
  target: ProbeTarget;
  json: boolean;
  markdown: boolean;
  strict: boolean;
  timeoutMs: number;
  outPath: string | null;
};

export function parseCliArgs(argv: string[]): { ok: true; value: ParsedCliArgs } | { ok: false; exitCode: number; message: string } {
  let mode: "stdio" | "http" | null = null;
  let httpUrl: string | null = null;
  let cwd: string | undefined;
  let json = false;
  let markdown = false;
  let strict = false;
  let timeoutMs = 15_000;
  let outPath: string | null = null;
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  let stdioCmd: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      stdioCmd = argv.slice(i + 1);
      if (mode === null) mode = "stdio";
      break;
    }
    if (arg === "-h" || arg === "--help") {
      return { ok: false, exitCode: 0, message: "HELP" };
    }
    if (arg === "-v" || arg === "--version") {
      return { ok: false, exitCode: 0, message: `VERSION:${TOOL_VERSION}` };
    }
    if (arg === "--stdio") {
      mode = "stdio";
      continue;
    }
    if (arg === "--http") {
      mode = "http";
      httpUrl = argv[++i] ?? null;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--markdown") {
      markdown = true;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--cwd") {
      cwd = argv[++i];
      continue;
    }
    if (arg === "--out") {
      outPath = argv[++i] ?? null;
      continue;
    }
    if (arg === "--timeout") {
      const parsed = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(parsed) || parsed < 500 || parsed > 120_000) {
        return { ok: false, exitCode: 2, message: "--timeout must be between 500 and 120000 ms." };
      }
      timeoutMs = parsed;
      continue;
    }
    if (arg === "--header") {
      const raw = argv[++i] ?? "";
      const sep = raw.indexOf(":");
      if (sep <= 0) {
        return { ok: false, exitCode: 2, message: `--header must be in "Key: Value" format.` };
      }
      headers[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim();
      continue;
    }
    if (arg === "--env") {
      const raw = argv[++i] ?? "";
      const sep = raw.indexOf("=");
      if (sep <= 0) {
        return { ok: false, exitCode: 2, message: "--env must be in KEY=VALUE format." };
      }
      env[raw.slice(0, sep)] = raw.slice(sep + 1);
      continue;
    }
    return { ok: false, exitCode: 2, message: `Unknown argument: ${arg}` };
  }

  if (mode === "http") {
    if (!httpUrl) {
      return { ok: false, exitCode: 2, message: "--http requires a URL." };
    }
    return {
      ok: true,
      value: {
        target: {
          transport: "http",
          url: httpUrl,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
        json,
        markdown,
        strict,
        timeoutMs,
        outPath,
      },
    };
  }

  if (mode === "stdio") {
    if (stdioCmd.length === 0) {
      return {
        ok: false,
        exitCode: 2,
        message: "--stdio requires a server command after -- (for example: mcp-probe --stdio -- node server.js).",
      };
    }
    return {
      ok: true,
      value: {
        target: {
          transport: "stdio",
          command: stdioCmd[0],
          args: stdioCmd.slice(1),
          ...(cwd ? { cwd } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        },
        json,
        markdown,
        strict,
        timeoutMs,
        outPath,
      },
    };
  }

  return { ok: false, exitCode: 2, message: "Specify either --stdio -- <cmd> or --http <url>." };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.message === "HELP") {
      printHelp();
      process.exit(0);
    }
    if (parsed.message.startsWith("VERSION:")) {
      process.stdout.write(`${parsed.message.slice(8)}\n`);
      process.exit(0);
    }
    process.stderr.write(`error: ${parsed.message}\n`);
    process.exit(parsed.exitCode);
  }

  const { target, json, markdown, strict, timeoutMs, outPath } = parsed.value;
  const report = await probeMcpServer(target, { stepTimeoutMs: timeoutMs, failOnWarn: strict });

  if (outPath) {
    const resolvedOut = path.resolve(outPath);
    await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
    await fs.writeFile(resolvedOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (markdown) {
    process.stdout.write(formatMarkdownSummary(report));
  } else {
    process.stdout.write(formatTerminalReport(report));
  }

  if (report.status === "error") {
    process.exit(2);
  }
  if (report.status === "failed" || (strict && report.status === "warned")) {
    process.exit(1);
  }
  process.exit(0);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));
if (isDirectRun) {
  void main();
}
