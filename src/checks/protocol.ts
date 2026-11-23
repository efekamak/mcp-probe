import { scrubText } from "../sanitize.js";
import type { ProbeTransport, RawProbeResult } from "../transports/types.js";
import type { CheckResult, McpPrompt, McpResource, McpServerInfo, McpTool } from "../types.js";
import { TOOL_VERSION } from "../version.js";

export type ProtocolRunResult = {
  connected: boolean;
  fatalError: string | null;
  server: McpServerInfo;
  tools: McpTool[];
  prompts: McpPrompt[];
  resources: McpResource[];
  checks: CheckResult[];
  rawErrorBodies: string[];
};

function looksLikeHtml(body: string, contentType?: string): boolean {
  if (contentType && contentType.toLowerCase().includes("text/html")) {
    return true;
  }
  const trimmed = body.trim().toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.includes("<pre>");
}

function summarizeRaw(res: RawProbeResult): string {
  if (res.transportError) return `transport error: ${scrubText(res.transportError, 180)}`;
  if (res.timedOut) return "no response before timeout";
  if (res.parsed?.error) {
    return `JSON-RPC error ${res.parsed.error.code}: ${scrubText(res.parsed.error.message, 160)}`;
  }
  if (res.httpStatus !== undefined) {
    return `HTTP ${res.httpStatus} (${res.contentType || "unknown"}): ${scrubText(res.rawBody, 160)}`;
  }
  return scrubText(res.rawBody, 160) || "empty response";
}

function hasPathTraversal(uri: string): boolean {
  const decoded = (() => {
    try {
      return decodeURIComponent(uri);
    } catch {
      return uri;
    }
  })();
  return /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(decoded);
}

export async function runProtocolChecks(
  transport: ProbeTransport,
  stepTimeoutMs: number,
): Promise<ProtocolRunResult> {
  const checks: CheckResult[] = [];
  const rawErrorBodies: string[] = [];
  const server: McpServerInfo = {
    name: null,
    version: null,
    protocolVersion: null,
    capabilities: [],
  };
  let tools: McpTool[] = [];
  let prompts: McpPrompt[] = [];
  let resources: McpResource[] = [];

  try {
    await transport.connect(stepTimeoutMs);
  } catch (err) {
    return {
      connected: false,
      fatalError: scrubText(err instanceof Error ? err.message : String(err), 400),
      server,
      tools,
      prompts,
      resources,
      checks,
      rawErrorBodies,
    };
  }

  // 1. Initialize handshake
  const initRes = await transport.request(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-probe", version: TOOL_VERSION },
    },
    stepTimeoutMs,
  );

  if (!initRes.received || !initRes.parsed || initRes.parsed.error || !initRes.parsed.result) {
    const stderr = transport.getStderrExcerpt();
    const detail = stderr ? `${summarizeRaw(initRes)} | stderr: ${scrubText(stderr, 240)}` : summarizeRaw(initRes);
    checks.push({
      id: "protocol.init-handshake",
      category: "protocol",
      title: "MCP initialize handshake",
      status: "fail",
      summary: `Server failed initialize handshake (${detail}).`,
    });
    return {
      connected: false,
      fatalError: `MCP initialize handshake failed: ${detail}`,
      server,
      tools,
      prompts,
      resources,
      checks,
      rawErrorBodies,
    };
  }

  const initObj = initRes.parsed.result as Record<string, unknown>;
  server.protocolVersion = typeof initObj.protocolVersion === "string" ? initObj.protocolVersion : null;
  if (initObj.serverInfo && typeof initObj.serverInfo === "object") {
    const info = initObj.serverInfo as Record<string, unknown>;
    server.name = typeof info.name === "string" ? info.name : null;
    server.version = typeof info.version === "string" ? info.version : null;
  }
  if (initObj.capabilities && typeof initObj.capabilities === "object" && !Array.isArray(initObj.capabilities)) {
    server.capabilities = Object.keys(initObj.capabilities as Record<string, unknown>).sort();
  }

  const initMissing: string[] = [];
  if (!server.protocolVersion) initMissing.push("protocolVersion");
  if (!server.name) initMissing.push("serverInfo.name");
  if (!initObj.capabilities || typeof initObj.capabilities !== "object" || Array.isArray(initObj.capabilities)) {
    initMissing.push("capabilities");
  }

  checks.push({
    id: "protocol.init-handshake",
    category: "protocol",
    title: "MCP initialize handshake",
    status: initMissing.length === 0 ? "pass" : "warn",
    summary:
      initMissing.length === 0
        ? `Negotiated protocol ${server.protocolVersion} with ${server.name}${server.version ? `@${server.version}` : ""}.`
        : `Initialize succeeded but omitted: ${initMissing.join(", ")}.`,
  });

  try {
    await transport.notify("notifications/initialized", undefined, Math.min(stepTimeoutMs, 5_000));
  } catch {
    // Handled by subsequent probes.
  }

  // 2. tools/list
  const listRes = await transport.request("tools/list", {}, stepTimeoutMs);
  if (listRes.received && listRes.parsed?.result && typeof listRes.parsed.result === "object") {
    const rawTools = (listRes.parsed.result as { tools?: unknown }).tools;
    if (Array.isArray(rawTools)) {
      tools = rawTools.filter((t): t is McpTool => Boolean(t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string" && (t as { name: string }).name.length > 0));
      const malformedTools = rawTools.length - tools.length;
      const names = tools.map((t) => t.name);
      const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
      checks.push({
        id: "protocol.tools-list",
        category: "protocol",
        title: "tools/list response structure",
        status: malformedTools === 0 && duplicates.length === 0 ? "pass" : "fail",
        summary:
          malformedTools > 0
            ? `Returned ${malformedTools} malformed tool entry/entries missing a non-empty string name.`
            : duplicates.length === 0
              ? `Returned ${tools.length} tool(s) with unique names.`
              : `Returned duplicate tool name(s): ${[...new Set(duplicates)].join(", ")}.`,
      });
    } else {
      checks.push({
        id: "protocol.tools-list",
        category: "protocol",
        title: "tools/list response structure",
        status: "fail",
        summary: "tools/list result did not contain a tools array.",
      });
    }
  } else if (listRes.parsed?.error?.code === -32601 && !server.capabilities.includes("tools")) {
    checks.push({
      id: "protocol.tools-list",
      category: "protocol",
      title: "tools/list response structure",
      status: "skip",
      summary: "Server does not advertise tools capability.",
    });
  } else {
    if (listRes.rawBody) rawErrorBodies.push(listRes.rawBody);
    checks.push({
      id: "protocol.tools-list",
      category: "protocol",
      title: "tools/list response structure",
      status: "fail",
      summary: `tools/list failed (${summarizeRaw(listRes)}).`,
    });
  }

  // 2b. prompts/list (only when server advertises prompts capability)
  if (server.capabilities.includes("prompts")) {
    const promptsRes = await transport.request("prompts/list", {}, Math.min(stepTimeoutMs, 8_000));
    if (promptsRes.received && promptsRes.parsed?.result && typeof promptsRes.parsed.result === "object") {
      const rawPrompts = (promptsRes.parsed.result as { prompts?: unknown }).prompts;
      if (Array.isArray(rawPrompts)) {
        prompts = rawPrompts.filter(
          (p): p is McpPrompt => Boolean(p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string" && (p as { name: string }).name.length > 0),
        );
        const malformedPrompts = rawPrompts.length - prompts.length;
        const names = prompts.map((p) => p.name);
        const dups = names.filter((n, i) => names.indexOf(n) !== i);
        checks.push({
          id: "protocol.prompts-list",
          category: "protocol",
          title: "prompts/list response structure",
          status: malformedPrompts === 0 && dups.length === 0 ? "pass" : "fail",
          summary:
            malformedPrompts > 0
              ? `Returned ${malformedPrompts} malformed prompt entry/entries missing a non-empty string name.`
              : dups.length === 0
                ? `Returned ${prompts.length} prompt(s) with unique names.`
                : `Returned duplicate prompt name(s): ${[...new Set(dups)].join(", ")}.`,
        });
      } else {
        checks.push({
          id: "protocol.prompts-list",
          category: "protocol",
          title: "prompts/list response structure",
          status: "fail",
          summary: "prompts/list result did not contain a prompts array.",
        });
      }
    } else {
      if (promptsRes.rawBody) rawErrorBodies.push(promptsRes.rawBody);
      checks.push({
        id: "protocol.prompts-list",
        category: "protocol",
        title: "prompts/list response structure",
        status: "fail",
        summary: `Server advertised prompts capability, but prompts/list failed (${summarizeRaw(promptsRes)}).`,
      });
    }
  }

  // 2c. resources/list (only when server advertises resources capability)
  if (server.capabilities.includes("resources")) {
    const resList = await transport.request("resources/list", {}, Math.min(stepTimeoutMs, 8_000));
    if (resList.received && resList.parsed?.result && typeof resList.parsed.result === "object") {
      const rawResources = (resList.parsed.result as { resources?: unknown }).resources;
      if (Array.isArray(rawResources)) {
        resources = rawResources.filter(
          (r): r is McpResource =>
            Boolean(
              r &&
                typeof r === "object" &&
                typeof (r as { uri?: unknown }).uri === "string" &&
                (r as { uri: string }).uri.length > 0 &&
                typeof (r as { name?: unknown }).name === "string" &&
                (r as { name: string }).name.length > 0,
            ),
        );
        const malformedResources = rawResources.length - resources.length;
        const badUris = resources
          .map((r) => r.uri)
          .filter((uri) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) || hasPathTraversal(uri));
        checks.push({
          id: "protocol.resources-list",
          category: "protocol",
          title: "resources/list URI structure",
          status: malformedResources === 0 && badUris.length === 0 ? "pass" : "fail",
          summary:
            malformedResources > 0
              ? `Returned ${malformedResources} malformed resource entry/entries missing uri or name.`
              : badUris.length === 0
                ? `Returned ${resources.length} resource(s) with valid URIs.`
                : `Found ${badUris.length} malformed or path-traversal resource URI(s).`,
          details: badUris.slice(0, 5).map((u) => scrubText(u, 140)),
        });
      } else {
        checks.push({
          id: "protocol.resources-list",
          category: "protocol",
          title: "resources/list URI structure",
          status: "fail",
          summary: "resources/list result did not contain a resources array.",
        });
      }
    } else {
      if (resList.rawBody) rawErrorBodies.push(resList.rawBody);
      checks.push({
        id: "protocol.resources-list",
        category: "protocol",
        title: "resources/list URI structure",
        status: "fail",
        summary: `Server advertised resources capability, but resources/list failed (${summarizeRaw(resList)}).`,
      });
    }
  }

  // 3. Unknown method -> JSON-RPC -32601
  const unknownMethodRes = await transport.request(
    "mcp_probe/nonexistent_method",
    {},
    Math.min(stepTimeoutMs, 5000),
  );
  if (unknownMethodRes.rawBody) rawErrorBodies.push(unknownMethodRes.rawBody);
  if (unknownMethodRes.parsed?.error?.code === -32601) {
    checks.push({
      id: "protocol.unknown-method",
      category: "protocol",
      title: "Unknown method returns JSON-RPC -32601",
      status: "pass",
      summary: "Returned JSON-RPC -32601 (Method not found).",
    });
  } else if (unknownMethodRes.parsed?.error) {
    checks.push({
      id: "protocol.unknown-method",
      category: "protocol",
      title: "Unknown method returns JSON-RPC -32601",
      status: "warn",
      summary: `Expected -32601, got ${unknownMethodRes.parsed.error.code} (${scrubText(unknownMethodRes.parsed.error.message, 100)}).`,
    });
  } else {
    checks.push({
      id: "protocol.unknown-method",
      category: "protocol",
      title: "Unknown method returns JSON-RPC -32601",
      status: "fail",
      summary: `Expected JSON-RPC -32601 error, got ${summarizeRaw(unknownMethodRes)}.`,
    });
  }

  // 4. Unknown tool -> error or isError: true
  if (tools.length > 0 || server.capabilities.includes("tools")) {
    const unknownToolRes = await transport.request(
      "tools/call",
      { name: "__mcp_probe_nonexistent_tool__", arguments: {} },
      Math.min(stepTimeoutMs, 10_000),
    );
    if (unknownToolRes.rawBody) rawErrorBodies.push(unknownToolRes.rawBody);
    const isToolError =
      Boolean(unknownToolRes.parsed?.error) ||
      Boolean(
        unknownToolRes.parsed?.result &&
          typeof unknownToolRes.parsed.result === "object" &&
          (unknownToolRes.parsed.result as { isError?: unknown }).isError === true,
      );
    checks.push({
      id: "protocol.unknown-tool",
      category: "protocol",
      title: "Unknown tool call handled cleanly",
      status: isToolError ? "pass" : "fail",
      summary: isToolError
        ? unknownToolRes.parsed?.error
          ? `Returned JSON-RPC error ${unknownToolRes.parsed.error.code}.`
          : "Returned tool result with isError: true."
        : `Expected error or isError: true, got ${summarizeRaw(unknownToolRes)}.`,
    });
  }

  // 5. Invalid JSON-RPC message (valid JSON, missing method) -> -32600
  const negTimeout = Math.min(stepTimeoutMs, 2500);
  const invalidReqRes = await transport.sendRawJson(
    { jsonrpc: "2.0", id: 999001 },
    999001,
    negTimeout,
  );
  if (invalidReqRes.rawBody) rawErrorBodies.push(invalidReqRes.rawBody);
  if (invalidReqRes.parsed?.error?.code === -32600) {
    checks.push({
      id: "protocol.invalid-jsonrpc",
      category: "protocol",
      title: "Invalid JSON-RPC request returns -32600",
      status: "pass",
      summary: "Returned JSON-RPC -32600 (Invalid Request) for valid JSON missing method.",
    });
  } else if (looksLikeHtml(invalidReqRes.rawBody, invalidReqRes.contentType)) {
    checks.push({
      id: "protocol.invalid-jsonrpc",
      category: "protocol",
      title: "Invalid JSON-RPC request returns -32600",
      status: "fail",
      summary: "Returned HTML error page instead of JSON-RPC -32600.",
    });
  } else if (invalidReqRes.parsed?.error) {
    checks.push({
      id: "protocol.invalid-jsonrpc",
      category: "protocol",
      title: "Invalid JSON-RPC request returns -32600",
      status: "fail",
      summary: `Returned JSON-RPC ${invalidReqRes.parsed.error.code} instead of -32600 (${scrubText(invalidReqRes.parsed.error.message, 100)}).`,
    });
  } else if (invalidReqRes.timedOut && transport.kind === "stdio") {
    checks.push({
      id: "protocol.invalid-jsonrpc",
      category: "protocol",
      title: "Invalid JSON-RPC request returns -32600",
      status: "warn",
      summary: "Server silently dropped invalid JSON-RPC request on stdio instead of replying with -32600.",
    });
  } else {
    checks.push({
      id: "protocol.invalid-jsonrpc",
      category: "protocol",
      title: "Invalid JSON-RPC request returns -32600",
      status: "fail",
      summary: `Expected JSON-RPC -32600, got ${summarizeRaw(invalidReqRes)}.`,
    });
  }

  // 6. Empty JSON-RPC batch [] -> -32600 (JSON-RPC 2.0 Section 6)
  if (transport.kind === "http") {
    const emptyBatchRes = await transport.sendRawJson([], null, negTimeout);
    if (emptyBatchRes.rawBody) rawErrorBodies.push(emptyBatchRes.rawBody);
    if (emptyBatchRes.parsed?.error?.code === -32600) {
      checks.push({
        id: "protocol.empty-batch",
        category: "protocol",
        title: "Empty JSON-RPC batch rejected with -32600",
        status: "pass",
        summary: "Rejected empty JSON-RPC batch [] with -32600 (Invalid Request).",
      });
    } else if (looksLikeHtml(emptyBatchRes.rawBody, emptyBatchRes.contentType)) {
      checks.push({
        id: "protocol.empty-batch",
        category: "protocol",
        title: "Empty JSON-RPC batch rejected with -32600",
        status: "fail",
        summary: "Returned HTML error page for empty JSON-RPC batch [].",
      });
    } else if (emptyBatchRes.parsed?.error) {
      checks.push({
        id: "protocol.empty-batch",
        category: "protocol",
        title: "Empty JSON-RPC batch rejected with -32600",
        status: "warn",
        summary: `Rejected empty batch [] with JSON-RPC ${emptyBatchRes.parsed.error.code} instead of -32600.`,
      });
    } else {
      checks.push({
        id: "protocol.empty-batch",
        category: "protocol",
        title: "Empty JSON-RPC batch rejected with -32600",
        status: "fail",
        summary: `Expected JSON-RPC -32600 for empty batch [], got ${summarizeRaw(emptyBatchRes)}.`,
      });
    }
  }

  // 7. Malformed JSON -> -32700 (never HTML / crash)
  const malformedRes = await transport.sendRawText("{not valid json", negTimeout);
  if (malformedRes.rawBody) rawErrorBodies.push(malformedRes.rawBody);
  if (malformedRes.parsed?.error?.code === -32700) {
    checks.push({
      id: "protocol.malformed-json",
      category: "protocol",
      title: "Malformed JSON returns -32700",
      status: "pass",
      summary: "Returned JSON-RPC -32700 (Parse error) with valid JSON body.",
    });
  } else if (looksLikeHtml(malformedRes.rawBody, malformedRes.contentType)) {
    checks.push({
      id: "protocol.malformed-json",
      category: "protocol",
      title: "Malformed JSON returns -32700",
      status: "fail",
      summary: "Returned HTML error response (possible stack trace leak) instead of JSON-RPC -32700.",
    });
  } else if (malformedRes.parsed?.error) {
    checks.push({
      id: "protocol.malformed-json",
      category: "protocol",
      title: "Malformed JSON returns -32700",
      status: "warn",
      summary: `Returned JSON-RPC ${malformedRes.parsed.error.code} instead of -32700.`,
    });
  } else if (malformedRes.timedOut && transport.kind === "stdio") {
    checks.push({
      id: "protocol.malformed-json",
      category: "protocol",
      title: "Malformed JSON returns -32700",
      status: "warn",
      summary: "Server silently ignored malformed JSON line on stdio instead of returning -32700.",
    });
  } else {
    checks.push({
      id: "protocol.malformed-json",
      category: "protocol",
      title: "Malformed JSON returns -32700",
      status: "fail",
      summary: `Expected JSON-RPC -32700, got ${summarizeRaw(malformedRes)}.`,
    });
  }

  // 8. Server still responsive after negative probes
  const pingRes = await transport.request("ping", undefined, Math.min(stepTimeoutMs, 5000));
  const survived =
    transport.isAlive() &&
    pingRes.received &&
    (pingRes.parsed?.result !== undefined || pingRes.parsed?.error?.code === -32601);
  checks.push({
    id: "protocol.alive-after-probes",
    category: "protocol",
    title: "Server remains responsive after malformed inputs",
    status: survived ? "pass" : "fail",
    summary: survived
      ? "Server stayed alive and answered ping cleanly after negative probes."
      : `Server became unresponsive after negative probes (${summarizeRaw(pingRes)}).`,
  });

  // 9. Stdio stdout framing cleanliness
  if (transport.kind === "stdio") {
    const stray = transport.getStrayStdoutLines();
    checks.push({
      id: "protocol.stdio-stdout-clean",
      category: "protocol",
      title: "Stdio stdout contains only JSON-RPC frames",
      status: stray.length === 0 ? "pass" : "fail",
      summary:
        stray.length === 0
          ? "No stray non-JSON-RPC output detected on stdout."
          : `Detected ${stray.length} non-JSON-RPC line(s) on stdout (corrupts stdio clients).`,
      details: stray.slice(0, 5).map((line) => scrubText(line, 160)),
    });
  }

  return {
    connected: true,
    fatalError: null,
    server,
    tools,
    prompts,
    resources,
    checks,
    rawErrorBodies,
  };
}
