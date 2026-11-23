import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseCliArgs } from "../src/cli.js";
import { runSafetyChecks } from "../src/checks/safety.js";
import { formatMarkdownSummary, formatTerminalReport } from "../src/format.js";
import { probeMcpServer, TOOL_VERSION } from "../src/runner.js";
import { scrubText } from "../src/sanitize.js";
import { toSarifReport } from "../src/sarif.js";

const REPO_ROOT = process.cwd();
const GOOD_STDIO = path.join(REPO_ROOT, "tests", "fixtures", "good-stdio-server.mjs");
const BROKEN_STDIO = path.join(REPO_ROOT, "tests", "fixtures", "broken-stdio-server.mjs");

async function startLocalHttpServer(
  mode: "good-json" | "good-sse" | "open-sse" | "broken-html" | "malformed-tools",
): Promise<{ url: string; close: () => Promise<void> }> {
  const openSockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body) as Record<string, unknown>;
      } catch {
        if (mode === "broken-html") {
          res.writeHead(400, { "content-type": "text/html" });
          res.end("<!DOCTYPE html><pre>SyntaxError: Unexpected token in /Users/dev/app.js</pre>");
          return;
        }
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }

      if (Array.isArray(msg) || !msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        const code = mode === "broken-html" ? -32700 : -32600;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: !Array.isArray(msg) && msg && typeof msg === "object" ? (msg.id ?? null) : null,
            error: { code, message: "Invalid Request" },
          }),
        );
        return;
      }

      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      const respond = (payload: unknown) => {
        if (mode === "open-sse") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": "sess-open",
          });
          // Intentionally keep the SSE stream open after flushing the JSON-RPC event.
          res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          return;
        }
        if (mode === "good-sse") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": "sess-123",
          });
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess-123",
        });
        res.end(JSON.stringify(payload));
      };

      if (msg.method === "initialize") {
        respond({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: `http-${mode}`, version: "1.0.0" },
          },
        });
        return;
      }
      if (msg.method === "ping") {
        respond({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      }
      if (msg.method === "tools/list") {
        if (mode === "malformed-tools") {
          respond({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "ok_tool",
                  description: "Valid tool.",
                  inputSchema: { type: "object", properties: {} },
                },
                { description: "Missing required tool name" },
              ],
            },
          });
          return;
        }
        respond({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              {
                name: "get_status",
                description: "Get service status.",
                inputSchema: {
                  type: "object",
                  properties: {
                    service: { type: "string", description: "Service name." },
                  },
                  required: ["service"],
                },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
        return;
      }
      if (msg.method === "tools/call") {
        respond({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Unknown tool" },
        });
        return;
      }
      respond({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not found" },
      });
    });
  });
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind local server");
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of openSockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("mcp-probe stdio audit", () => {
  it("scores a clean compliant stdio server with Grade A and zero failures", async () => {
    const report = await probeMcpServer({
      transport: "stdio",
      command: "node",
      args: [GOOD_STDIO],
    });

    assert.equal(report.fatalError, null);
    assert.equal(report.counts.fail, 0);
    assert.equal(report.grade, "A");
    assert.equal(report.server.name, "good-fixture-mcp");
    assert.equal(report.context.toolCount, 1);
    assert.equal(report.context.promptCount, 1);
    assert.equal(report.context.resourceCount, 1);
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("protocol.prompts-list")?.status, "pass");
    assert.equal(byId.get("protocol.resources-list")?.status, "pass");
    assert.equal(report.providers.openai.compatible, true);
    assert.equal(report.providers.anthropic.compatible, true);
    assert.equal(report.providers.gemini.compatible, true);
    assert.equal(report.providers.cursor.compatible, true);
    assert.equal(report.safety.passed, true);

    const terminal = formatTerminalReport(report);
    assert.match(terminal, /good-fixture-mcp@1\.0\.0/);
    const md = formatMarkdownSummary(report);
    assert.match(md, /<h3>mcp-probe:/);
  });

  it("catches stray stdout, wrong JSON-RPC code, schema failures, tool poisoning, and secret leaks", async () => {
    const report = await probeMcpServer({
      transport: "stdio",
      command: "node",
      args: [BROKEN_STDIO],
    });

    assert.equal(report.status, "failed");
    assert.equal(report.safety.passed, false);

    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("protocol.stdio-stdout-clean")?.status, "fail");
    assert.equal(byId.get("protocol.invalid-jsonrpc")?.status, "fail");
    assert.equal(byId.get("protocol.resources-list")?.status, "fail");
    assert.equal(byId.get("schema.compat-openai")?.status, "fail");
    assert.equal(byId.get("schema.compat-gemini")?.status, "fail");
    assert.equal(byId.get("safety.tool-poisoning")?.status, "fail");
    assert.equal(byId.get("safety.error-hygiene")?.status, "fail");
    assert.ok(report.safety.findings.some((f) => f.tool === "prompt:sneaky_prompt"));

    const sarif = toSarifReport(report);
    assert.equal(sarif.version, "2.1.0");
    assert.ok(sarif.runs[0].results.some((r) => r.ruleId === "safety.tool-poisoning" && r.level === "error"));

    // Ensure leaked secret is scrubbed in the serialized report
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /sk-fakeleak1234567890abcdef/);
    assert.doesNotMatch(serialized, /\/Users\/devuser/);
  });
});

describe("mcp-probe Streamable HTTP audit", () => {
  it("audits JSON and SSE Streamable HTTP endpoints cleanly", async () => {
    for (const mode of ["good-json", "good-sse"] as const) {
      const srv = await startLocalHttpServer(mode);
      try {
        const report = await probeMcpServer({ transport: "http", url: srv.url });
        assert.equal(report.fatalError, null);
        assert.equal(report.counts.fail, 0);
        assert.equal(report.grade, "A");
        assert.equal(report.server.name, `http-${mode}`);
      } finally {
        await srv.close();
      }
    }
  });

  it("catches HTML stack trace leaks and -32700 instead of -32600 over HTTP", async () => {
    const srv = await startLocalHttpServer("broken-html");
    try {
      const report = await probeMcpServer({ transport: "http", url: srv.url });
      assert.equal(report.status, "failed");
      const byId = new Map(report.checks.map((c) => [c.id, c]));
      assert.equal(byId.get("protocol.malformed-json")?.status, "fail");
      assert.equal(byId.get("protocol.invalid-jsonrpc")?.status, "fail");
      assert.equal(byId.get("safety.error-hygiene")?.status, "warn");
    } finally {
      await srv.close();
    }
  });

  it("completes promptly on open Streamable HTTP SSE streams without waiting for EOF", async () => {
    const srv = await startLocalHttpServer("open-sse");
    try {
      const started = Date.now();
      const report = await probeMcpServer({ transport: "http", url: srv.url }, { stepTimeoutMs: 5_000 });
      const elapsed = Date.now() - started;
      assert.equal(report.fatalError, null);
      assert.equal(report.counts.fail, 0);
      assert.equal(report.grade, "A");
      assert.ok(elapsed < 3_000, `Expected open SSE probe to return early, took ${elapsed}ms`);
    } finally {
      await srv.close();
    }
  });

  it("fails protocol.tools-list when tools array contains malformed entries", async () => {
    const srv = await startLocalHttpServer("malformed-tools");
    try {
      const report = await probeMcpServer({ transport: "http", url: srv.url });
      const byId = new Map(report.checks.map((c) => [c.id, c]));
      assert.equal(byId.get("protocol.tools-list")?.status, "fail");
      assert.match(byId.get("protocol.tools-list")?.summary ?? "", /malformed tool entry/i);
    } finally {
      await srv.close();
    }
  });

  it("bounds oversized HTTP responses (> 2 MiB) during streaming without OOM", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Stream 3 MiB of invalid padding to verify the 2 MiB streaming cap cancels early.
      const chunk = Buffer.alloc(64 * 1024, "x");
      for (let i = 0; i < 48; i += 1) {
        if (!res.write(chunk)) break;
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind server");
    try {
      const report = await probeMcpServer(
        { transport: "http", url: `http://127.0.0.1:${addr.port}/mcp` },
        { stepTimeoutMs: 5_000 },
      );
      assert.equal(report.status, "error");
      assert.ok(report.fatalError !== null);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("CLI parsing and bundled GitHub Action", () => {
  it("parses stdio and http arguments cleanly", () => {
    const stdio = parseCliArgs(["--stdio", "--json", "--strict", "--", "node", "server.js"]);
    assert.equal(stdio.ok, true);
    if (stdio.ok) {
      assert.equal(stdio.value.target.transport, "stdio");
      assert.equal(stdio.value.json, true);
      assert.equal(stdio.value.strict, true);
    }

    const httpArg = parseCliArgs(["--http", "https://example.com/mcp", "--header", "X-Test: 1"]);
    assert.equal(httpArg.ok, true);
    if (httpArg.ok && httpArg.value.target.transport === "http") {
      assert.equal(httpArg.value.target.url, "https://example.com/mcp");
      assert.equal(httpArg.value.target.headers?.["X-Test"], "1");
    }

    const bad = parseCliArgs([]);
    assert.equal(bad.ok, false);

    assert.equal(parseCliArgs(["--cwd"]).ok, false);
    assert.equal(parseCliArgs(["--out"]).ok, false);
    assert.equal(parseCliArgs(["--sarif-out", "--", "node", "x.js"]).ok, false);
    assert.equal(parseCliArgs(["--stdio", "--http", "https://example.com/mcp", "--", "node", "x.js"]).ok, false);
    assert.equal(parseCliArgs(["--http", "https://example.com/mcp", "--", "node", "x.js"]).ok, false);
    assert.equal(parseCliArgs(["--http", "https://example.com/mcp", "--timeout", "500abc"]).ok, false);

    // ReDoS regression guard: 50KB adversarial tag spacing must stay strictly linear (< 100ms).
    const redosStart = Date.now();
    const redosPayload = `<${" ".repeat(50_000)}IMPORTANT`;
    const safetyRes = runSafetyChecks(
      [{ name: "t", description: redosPayload, inputSchema: { type: "object", properties: {} } }],
      [redosPayload],
    );
    assert.equal(safetyRes.safety.passed, true);
    assert.ok(Date.now() - redosStart < 100, `Expected linear safety scan, took ${Date.now() - redosStart}ms`);

    const encodedSarif = toSarifReport({
      schemaVersion: 1,
      tool: "mcp-probe",
      toolVersion: TOOL_VERSION,
      timestamp: new Date().toISOString(),
      durationMs: 1,
      target: { transport: "stdio", display: "node server.js" },
      server: { name: "My Server (v1)", version: "1.0", protocolVersion: "2025-03-26", capabilities: [] },
      score: 50,
      grade: "D",
      status: "failed",
      counts: { pass: 0, warn: 0, fail: 1, skip: 0 },
      checks: [{ id: "protocol.test", category: "protocol", title: "t", status: "fail", summary: "s" }],
      providers: {
        openai: { provider: "openai", compatible: true, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
        anthropic: { provider: "anthropic", compatible: true, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
        gemini: { provider: "gemini", compatible: true, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
        cursor: { provider: "cursor", compatible: true, compatibleTools: 0, totalTools: 0, errors: 0, warnings: 0, issues: [] },
      },
      context: { toolCount: 0, promptCount: 0, resourceCount: 0, totalBytes: 0, estimatedTokens: 0, missingDescriptions: 0, missingAnnotations: 0, heaviestTools: [] },
      safety: { passed: true, errors: 0, warnings: 0, findings: [] },
      fatalError: null,
    });
    const sarifUri = encodedSarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    assert.equal(sarifUri, "mcp://My%20Server%20(v1)");
    assert.doesNotMatch(sarifUri, /\s/);
  });

  it("executes the committed dist-action/index.js bundle end-to-end", async () => {
    const bundlePath = path.join(REPO_ROOT, "dist-action", "index.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-probe-act-"));
    const outFile = path.join(tmpDir, "github-output.txt");
    const sumFile = path.join(tmpDir, "github-summary.md");
    await fs.writeFile(outFile, "", "utf8");
    await fs.writeFile(sumFile, "", "utf8");

    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [bundlePath], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: REPO_ROOT,
            RUNNER_TEMP: tmpDir,
            GITHUB_OUTPUT: outFile,
            GITHUB_STEP_SUMMARY: sumFile,
            INPUT_COMMAND: "node",
            INPUT_ARGS: JSON.stringify(["tests/fixtures/good-stdio-server.mjs"]),
            "INPUT_WORKING-DIRECTORY": ".",
            "INPUT_TIMEOUT-MS": "10000",
            "INPUT_FAIL-ON": "fail",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.on("error", reject);
        child.on("close", resolve);
      });

      assert.equal(code, 0);
      const outputs = await fs.readFile(outFile, "utf8");
      assert.match(outputs, /grade<<[\s\S]*?\r?\nA\r?\n/);
      assert.match(outputs, /tool-count<<[\s\S]*?\r?\n1\r?\n/);
      assert.match(outputs, /sarif-path<<[\s\S]*?\.sarif\r?\n/);
      const summary = await fs.readFile(sumFile, "utf8");
      assert.match(summary, /<h3>mcp-probe:/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles a stdio server that crashes mid-probe without unhandled EPIPE", async () => {
    const crashingScript = [
      "import * as readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  const m = JSON.parse(line);",
      "  if (m.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'crasher', version: '0.1.0' } } }) + '\\n');",
      "  } else if (m.method === 'tools/list') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) + '\\n');",
      "    process.exit(1);",
      "  }",
      "});",
    ].join("\n");

    const report = await probeMcpServer(
      { transport: "stdio", command: "node", args: ["--input-type=module", "-e", crashingScript] },
      { stepTimeoutMs: 3000 },
    );
    assert.equal(report.status, "failed");
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("protocol.alive-after-probes")?.status, "fail");
  });

  it("drops oversized unterminated stdio stdout (> 4 MiB) and accepts Gemini Schema default without false warning", async () => {
    const script = [
      "import * as readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  let m; try { m = JSON.parse(line); } catch {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\\n');",
      "    return;",
      "  }",
      "  if (!m || typeof m !== 'object' || typeof m.method !== 'string') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }) + '\\n');",
      "    return;",
      "  }",
      "  if (m.id === undefined) return;",
      "  if (m.method === 'initialize') {",
      "    process.stdout.write('A'.repeat(4_300_000));",
      "    process.stdout.write('\\n' + JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stress', version: '1.0.0' } } }) + '\\n');",
      "  } else if (m.method === 'tools/list') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 't1', description: 'Tool with default.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, default: 10 } } }, annotations: { readOnlyHint: true } }] } }) + '\\n');",
      "  } else if (m.method === 'ping') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n');",
      "  } else if (m.method === 'tools/call') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } }) + '\\n');",
      "  } else {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');",
      "  }",
      "});",
    ].join("\n");

    const report = await probeMcpServer(
      { transport: "stdio", command: "node", args: ["--input-type=module", "-e", script] },
      { stepTimeoutMs: 5_000 },
    );
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("protocol.stdio-stdout-clean")?.status, "fail");
    assert.equal(report.providers.gemini.compatible, true);
    assert.equal(report.providers.gemini.warnings, 0);
  });

  it("scrubs URL query-string, JWT, npm, and private-key secrets and runs built CLI --version cleanly", async () => {
    const scrubbed = scrubText("https://mcp.example.com/mcp?api_key=super_secret_12345&ok=1");
    assert.doesNotMatch(scrubbed, /super_secret_12345/);
    assert.match(scrubbed, /api_key=\[REDACTED\]/);

    const jwtScrubbed = scrubText("token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789");
    assert.match(jwtScrubbed, /\[REDACTED_JWT\]/);

    const npmScrubbed = scrubText("npm_1234567890abcdefghij1234");
    assert.match(npmScrubbed, /\[REDACTED_NPM_TOKEN\]/);

    const keyScrubbed = scrubText("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----");
    assert.match(keyScrubbed, /\[REDACTED_PRIVATE_KEY\]/);

    const cliPath = path.join(REPO_ROOT, "dist", "cli.js");
    const out = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const child = spawn(process.execPath, [cliPath, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`CLI exited ${code}`));
        else resolve(stdout.trim());
      });
    });
    assert.equal(out, TOOL_VERSION);
  });
});
