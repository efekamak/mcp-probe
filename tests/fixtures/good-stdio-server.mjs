import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: Invalid JSON" },
    });
    return;
  }

  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    send({
      jsonrpc: "2.0",
      id: msg && typeof msg === "object" && !Array.isArray(msg) && msg.id !== undefined ? msg.id : null,
      error: { code: -32600, message: "Invalid Request" },
    });
    return;
  }

  if (msg.id === undefined) {
    return; // Notification
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "good-fixture-mcp", version: "1.0.0" },
      },
    });
    return;
  }

  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "search_docs",
            description: "Search project documentation by keyword.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query string." },
              },
              required: ["query"],
            },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
            },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "search_docs") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32602, message: `Unknown tool: ${String(name)}` },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  });
});
