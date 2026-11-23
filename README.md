# mcp-probe

Deterministic conformance, cross-provider tool schema compatibility, context token budget, and tool-poisoning audit CLI and GitHub Action for Model Context Protocol (MCP) servers.

Live daily scorecard: [efekamak.github.io/mcp-probe](https://efekamak.github.io/mcp-probe/)

## What it checks (zero LLM calls)

Connects directly to any MCP server over **stdio** or **Streamable HTTP** (`application/json` and `text/event-stream`) and runs 4 deterministic audit suites:

1. **JSON-RPC 2.0 & MCP protocol conformance**
   - `initialize` handshake (`protocolVersion`, `serverInfo`, `capabilities`) and `notifications/initialized`
   - `tools/list`, `prompts/list`, and `resources/list` validity (unique names, valid URIs, path-traversal checks)
   - Unknown method returns JSON-RPC `-32601`
   - Unknown `tools/call` handled cleanly with JSON-RPC error or `isError: true`
   - Invalid JSON-RPC request (`{"jsonrpc":"2.0","id":999001}`) and empty HTTP batch (`[]`) return `-32600` (not `-32700`, not HTML)
   - Malformed JSON returns `-32700` without leaking HTML stack traces
   - Server stays alive and responds to `ping` after negative probes
   - Stdio stdout framing cleanliness (flags stray non-JSON log lines that corrupt stdio clients)
2. **Cross-provider tool schema compatibility**
   - **OpenAI:** tool name regex `^[a-zA-Z0-9_-]{1,64}$`, root `type: "object"`, array `items`, non-empty `enum`, strict-mode readiness (`additionalProperties: false`)
   - **Anthropic (Claude):** tool name regex `^[a-zA-Z0-9_-]{1,128}$`, root `type: "object"`, descriptions
   - **Google Gemini:** tool name regex, union `type` arrays, unsupported keywords (`$ref`, `$defs`, `oneOf`, `allOf`, `not`, `const`, `patternProperties`, `exclusiveMinimum`/`exclusiveMaximum`), plus warnings for OpenAPI `parameters` keywords (`$schema`, `additionalProperties`, `default`, nested `anyOf`)
   - **Cursor:** tool name limits, 40-tool active budget warning, MCP safety annotations (`readOnlyHint`, `destructiveHint`)
3. **Context & token budget**
   - Serialized UTF-8 byte size and estimated token cost (`ceil(bytes / 4)`) of `tools/list` injected on every model turn, heaviest tools breakdown, missing or oversized descriptions, and missing MCP annotations
4. **Tool-poisoning & error hygiene**
   - Flags invisible zero-width / BiDi Unicode characters (`U+200B..200F`, `U+202A..202E`, `U+2060..206F`, `U+FEFF`)
   - Flags prompt-injection directives (`ignore previous instructions`, `do not tell the user`, `<IMPORTANT>`, `<system>`, sensitive credential file references, cross-tool shadowing phrases)
   - Flags unredacted secret patterns or host user filesystem paths leaked in server error responses

## CLI usage

```bash
# Audit a local stdio MCP server
npx mcp-probe --stdio -- node ./dist/server.js

# Audit a published npm MCP server
npx mcp-probe --stdio -- npx -y @playwright/mcp

# Audit a Streamable HTTP MCP endpoint
npx mcp-probe --http http://127.0.0.1:3000/mcp

# Emit JSON, SARIF 2.1.0 (for GitHub Code Scanning), or Markdown summary
npx mcp-probe --stdio --sarif --sarif-out mcp-probe.sarif -- node ./dist/server.js
npx mcp-probe --stdio --json --strict -- node ./dist/server.js
```

Exit codes: `0` passed (or warned without `--strict`), `1` failed (or warned with `--strict`), `2` usage or connection error.

## Use as a GitHub Action

```yaml
name: MCP audit

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - uses: efekamak/mcp-probe@v0.2.1
        with:
          command: node
          args: '["dist/server.js"]'
```

### Action inputs

| Input | Default | Description |
| --- | --- | --- |
| `command` | `""` | Executable for stdio transport (`node`, `npx`, `python`, etc.). |
| `args` | `""` | JSON array or whitespace-separated args for `command`. |
| `http-url` | `""` | Streamable HTTP MCP endpoint URL (alternative to `command`). |
| `working-directory` | `.` | Relative working directory inside `GITHUB_WORKSPACE`. |
| `timeout-ms` | `15000` | Per-step timeout in milliseconds (`500` to `120000`). |
| `fail-on` | `fail` | Failure threshold: `fail`, `warn`, or `none`. |

### Action outputs

| Output | Description |
| --- | --- |
| `status` | `passed`, `warned`, `failed`, or `error`. |
| `score` | Numeric score (`0` to `100`). |
| `grade` | Letter grade (`A` to `F`). |
| `tool-count` | Number of tools exposed by `tools/list`. |
| `estimated-tokens` | Estimated context tokens consumed by `tools/list`. |
| `failed-checks` | Number of failed checks. |
| `result-path` | Path under `RUNNER_TEMP` to the JSON audit report. |
| `sarif-path` | Path under `RUNNER_TEMP` to the SARIF 2.1.0 report for GitHub Code Scanning. |

## Security boundaries

- Spawns stdio targets with `shell: false` (resolving `npm`/`npx` directly via `npm-cli.js`/`npx-cli.js` so Windows works without `cmd.exe`).
- Strips host environment secrets (`GITHUB_TOKEN`, OIDC, API keys) from child processes unless explicitly passed via `--env`.
- Scrubs detected secret patterns and host user paths from serialized reports and summaries.
- Auditing an untrusted third-party MCP server still executes that server's process under the current user (not a VM sandbox).

## Local development

```bash
npm ci
npm run check
npm run build
npm run action:build
npm run action:verify
npm test
```
