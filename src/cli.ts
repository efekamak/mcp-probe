#!/usr/bin/env node
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatMarkdownSummary, formatTerminalReport } from "./format.js";
import { probeMcpServer, TOOL_VERSION } from "./runner.js";
import { toSarifReport } from "./sarif.js";
import type { GeminiSchemaMode, ProbeTarget, TokenizerMode } from "./types.js";

function printHelp(): void {
  process.stdout.write(`mcp-probe v${TOOL_VERSION}

Deterministic conformance, cross-provider tool schema compatibility,
context budget, and tool-poisoning audit for MCP servers.

Usage:
  mcp-probe --stdio -- <command> [args...]
  mcp-probe --http <url> [options]

Options:
  --stdio                       Connect to an MCP server over stdio (put command after --)
  --http <url>                  Connect to a Streamable HTTP MCP endpoint
  --header "Key: Value"         Add an HTTP request header (repeatable)
  --env KEY=VALUE               Pass an explicit env var to a stdio server (repeatable)
  --cwd <dir>                   Working directory for stdio server
  --timeout <ms>                Per-step timeout in ms (default: 15000)
  --tokenizer <o200k|bytes4>    Token counter for context budget (default: o200k_base)
  --gemini-mode <mode>          Gemini schema mode: json-schema (default) or parameters
  --json                        Print JSON report to stdout
  --markdown                    Print HTML/Markdown summary to stdout
  --sarif                       Print SARIF 2.1.0 report to stdout
  --out <file>                  Write JSON report to a file
  --sarif-out <file>            Write SARIF 2.1.0 report to a file
  --strict                      Exit 1 on warnings as well as failures
  -v, --version                 Print version
  -h, --help                    Show this help
`);
}

export type ParsedCliArgs = {
  target: ProbeTarget;
  json: boolean;
  markdown: boolean;
  sarif: boolean;
  strict: boolean;
  timeoutMs: number;
  tokenizer: TokenizerMode;
  geminiMode: GeminiSchemaMode;
  outPath: string | null;
  sarifOutPath: string | null;
};

export function parseCliArgs(argv: string[]): { ok: true; value: ParsedCliArgs } | { ok: false; exitCode: number; message: string } {
  let mode: "stdio" | "http" | null = null;
  let httpUrl: string | null = null;
  let cwd: string | undefined;
  let json = false;
  let markdown = false;
  let sarif = false;
  let strict = false;
  let timeoutMs = 15_000;
  let tokenizer: TokenizerMode = "o200k_base";
  let geminiMode: GeminiSchemaMode = "json-schema";
  let outPath: string | null = null;
  let sarifOutPath: string | null = null;
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  let stdioCmd: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      if (mode === "http") {
        return { ok: false, exitCode: 2, message: "Cannot combine --http with -- <stdio command>." };
      }
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
      if (mode === "http") {
        return { ok: false, exitCode: 2, message: "Cannot combine --stdio and --http." };
      }
      mode = "stdio";
      continue;
    }
    if (arg === "--http") {
      if (mode === "stdio") {
        return { ok: false, exitCode: 2, message: "Cannot combine --stdio and --http." };
      }
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
    if (arg === "--sarif") {
      sarif = true;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--cwd") {
      const next = argv[++i];
      if (!next || next === "--") {
        return { ok: false, exitCode: 2, message: "--cwd requires a directory path." };
      }
      cwd = next;
      continue;
    }
    if (arg === "--out") {
      const next = argv[++i];
      if (!next || next === "--") {
        return { ok: false, exitCode: 2, message: "--out requires a file path." };
      }
      outPath = next;
      continue;
    }
    if (arg === "--sarif-out") {
      const next = argv[++i];
      if (!next || next === "--") {
        return { ok: false, exitCode: 2, message: "--sarif-out requires a file path." };
      }
      sarifOutPath = next;
      continue;
    }
    if (arg === "--timeout") {
      const rawTimeout = argv[++i] ?? "";
      const parsed = /^\d+$/.test(rawTimeout) ? Number.parseInt(rawTimeout, 10) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed < 500 || parsed > 120_000) {
        return { ok: false, exitCode: 2, message: "--timeout must be between 500 and 120000 ms." };
      }
      timeoutMs = parsed;
      continue;
    }
    if (arg === "--tokenizer") {
      const rawTok = (argv[++i] ?? "").trim().toLowerCase();
      if (rawTok === "o200k" || rawTok === "o200k_base") {
        tokenizer = "o200k_base";
      } else if (rawTok === "bytes4") {
        tokenizer = "bytes4";
      } else {
        return { ok: false, exitCode: 2, message: "--tokenizer must be o200k_base (or o200k) or bytes4." };
      }
      continue;
    }
    if (arg === "--gemini-mode") {
      const rawMode = (argv[++i] ?? "").trim().toLowerCase();
      if (rawMode === "json-schema" || rawMode === "parameters") {
        geminiMode = rawMode;
      } else {
        return { ok: false, exitCode: 2, message: "--gemini-mode must be json-schema or parameters." };
      }
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
        sarif,
        strict,
        timeoutMs,
        tokenizer,
        geminiMode,
        outPath,
        sarifOutPath,
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
        sarif,
        strict,
        timeoutMs,
        tokenizer,
        geminiMode,
        outPath,
        sarifOutPath,
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

  const { target, json, markdown, sarif, strict, timeoutMs, tokenizer, geminiMode, outPath, sarifOutPath } = parsed.value;
  const report = await probeMcpServer(target, {
    stepTimeoutMs: timeoutMs,
    failOnWarn: strict,
    tokenizer,
    geminiMode,
  });

  if (outPath) {
    const resolvedOut = path.resolve(outPath);
    await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
    await fs.writeFile(resolvedOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (sarifOutPath) {
    const resolvedSarif = path.resolve(sarifOutPath);
    await fs.mkdir(path.dirname(resolvedSarif), { recursive: true });
    await fs.writeFile(resolvedSarif, `${JSON.stringify(toSarifReport(report), null, 2)}\n`, "utf8");
  }

  if (sarif) {
    process.stdout.write(`${JSON.stringify(toSarifReport(report), null, 2)}\n`);
  } else if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (markdown) {
    process.stdout.write(formatMarkdownSummary(report));
  } else {
    process.stdout.write(formatTerminalReport(report));
  }

  if (report.status === "error") {
    process.exitCode = 2;
    return;
  }
  if (report.status === "failed" || (strict && report.status === "warned")) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

function isDirectCliExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const argvReal = realpathSync(process.argv[1]);
    const selfReal = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32"
      ? argvReal.toLowerCase() === selfReal.toLowerCase()
      : argvReal === selfReal;
  } catch {
    return process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts");
  }
}

if (isDirectCliExecution()) {
  void main();
}
