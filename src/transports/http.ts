import type { HttpTarget } from "../types.js";
import type { JsonRpcResponse, ProbeTransport, RawProbeResult } from "./types.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function parseSseForJsonRpc(body: string, expectId: number | null): JsonRpcResponse | null {
  const events = body.split(/\r?\n\r?\n/);
  let fallback: JsonRpcResponse | null = null;
  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const joined = dataLines.join("\n").trim();
    if (joined.length === 0 || joined === "[DONE]") continue;
    try {
      const parsed = JSON.parse(joined) as JsonRpcResponse;
      if (parsed && typeof parsed === "object") {
        if (expectId !== null && parsed.id === expectId) {
          return parsed;
        }
        if (parsed.result !== undefined || parsed.error !== undefined) {
          fallback = parsed;
        }
      }
    } catch {
      // Ignore non-JSON SSE comments/keepalives.
    }
  }
  return fallback;
}

export class HttpProbeTransport implements ProbeTransport {
  readonly kind = "http" as const;
  private readonly target: HttpTarget;
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private reachable = true;

  constructor(target: HttpTarget) {
    this.target = target;
  }

  async connect(_timeoutMs: number): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(this.target.url);
    } catch {
      throw new Error(`Invalid HTTP URL: "${this.target.url}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol "${parsed.protocol}" (expected http: or https:).`);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.target.headers ?? {}),
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    if (this.protocolVersion) {
      headers["mcp-protocol-version"] = this.protocolVersion;
    }
    return headers;
  }

  private async postBody(
    bodyText: string,
    expectId: number | null,
    timeoutMs: number,
  ): Promise<RawProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(this.target.url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: bodyText,
        signal: controller.signal,
      });

      const sid = res.headers.get("mcp-session-id");
      if (sid && !this.sessionId) {
        this.sessionId = sid;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const rawBuf = Buffer.from(await res.arrayBuffer());
      const rawBody =
        rawBuf.byteLength > MAX_RESPONSE_BYTES
          ? rawBuf.subarray(0, MAX_RESPONSE_BYTES).toString("utf8")
          : rawBuf.toString("utf8");

      let parsed: JsonRpcResponse | null = null;
      if (contentType.toLowerCase().includes("text/event-stream")) {
        parsed = parseSseForJsonRpc(rawBody, expectId);
      } else if (rawBody.trim().length > 0) {
        try {
          const json: unknown = JSON.parse(rawBody);
          if (json && typeof json === "object" && !Array.isArray(json)) {
            parsed = json as JsonRpcResponse;
          }
        } catch {
          parsed = null;
        }
      }

      if (
        parsed?.result &&
        typeof parsed.result === "object" &&
        typeof (parsed.result as { protocolVersion?: unknown }).protocolVersion === "string"
      ) {
        this.protocolVersion = (parsed.result as { protocolVersion: string }).protocolVersion;
      }

      return {
        received: true,
        timedOut: false,
        httpStatus: res.status,
        contentType,
        rawBody,
        parsed,
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        this.reachable = false;
      }
      return {
        received: false,
        timedOut: isAbort,
        rawBody: "",
        parsed: null,
        transportError: isAbort ? undefined : err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<RawProbeResult> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      payload.params = params;
    }
    return this.postBody(JSON.stringify(payload), id, timeoutMs);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      payload.params = params;
    }
    await this.postBody(JSON.stringify(payload), null, 5000);
  }

  async sendRawJson(
    payload: unknown,
    expectId: number | null,
    timeoutMs: number,
  ): Promise<RawProbeResult> {
    return this.postBody(JSON.stringify(payload), expectId, timeoutMs);
  }

  async sendRawText(raw: string, timeoutMs: number): Promise<RawProbeResult> {
    return this.postBody(raw, null, timeoutMs);
  }

  getStrayStdoutLines(): string[] {
    return [];
  }

  getStderrExcerpt(): string {
    return "";
  }

  isAlive(): boolean {
    return this.reachable;
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      await fetch(this.target.url, {
        method: "DELETE",
        headers: this.buildHeaders(),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    } catch {
      // Best-effort session teardown.
    }
  }
}
