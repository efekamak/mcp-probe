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

function findLastSseBoundaryEnd(text: string): number {
  const lf = text.lastIndexOf("\n\n");
  const crlf = text.lastIndexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  const lfEnd = lf === -1 ? -1 : lf + 2;
  const crlfEnd = crlf === -1 ? -1 : crlf + 4;
  return Math.max(lfEnd, crlfEnd);
}

async function readBoundedResponse(
  res: Response,
  isSse: boolean,
  expectId: number | null,
  maxBytes: number,
): Promise<{ rawBody: string; sseParsed: JsonRpcResponse | null }> {
  if (!res.body) {
    return { rawBody: "", sseParsed: null };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let sseText = "";
  const decoder = isSse ? new TextDecoder("utf-8") : null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        break;
      }

      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      totalBytes += slice.byteLength;

      if (isSse && decoder) {
        sseText += decoder.decode(slice, { stream: true });
        // Inspect only completed SSE event blocks terminated by a blank line (linear O(N) scan).
        const boundaryEnd = findLastSseBoundaryEnd(sseText);
        if (boundaryEnd !== -1) {
          const candidate = parseSseForJsonRpc(sseText.slice(0, boundaryEnd), expectId);
          if (candidate && (expectId === null || candidate.id === expectId)) {
            await reader.cancel().catch(() => {});
            return { rawBody: sseText, sseParsed: candidate };
          }
        }
      }

      if (totalBytes >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const rawBody = isSse && decoder
    ? sseText + decoder.decode()
    : Buffer.concat(chunks, totalBytes).toString("utf8");
  const sseParsed = isSse ? parseSseForJsonRpc(rawBody, expectId) : null;
  return { rawBody, sseParsed };
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

  private buildHeaders(): Headers {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    if (this.target.headers) {
      for (const [key, value] of Object.entries(this.target.headers)) {
        headers.set(key, value);
      }
    }
    if (this.sessionId) {
      headers.set("mcp-session-id", this.sessionId);
    }
    if (this.protocolVersion) {
      headers.set("mcp-protocol-version", this.protocolVersion);
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
      const isSse = contentType.toLowerCase().includes("text/event-stream");
      const { rawBody, sseParsed } = await readBoundedResponse(
        res,
        isSse,
        expectId,
        MAX_RESPONSE_BYTES,
      );

      let parsed: JsonRpcResponse | null = null;
      if (isSse) {
        parsed = sseParsed;
      } else if (rawBody.trim().length > 0) {
        try {
          const json: unknown = JSON.parse(rawBody);
          if (json && typeof json === "object" && !Array.isArray(json)) {
            parsed = json as JsonRpcResponse;
          } else if (
            Array.isArray(json) &&
            json.length === 1 &&
            json[0] &&
            typeof json[0] === "object" &&
            !Array.isArray(json[0])
          ) {
            parsed = json[0] as JsonRpcResponse;
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

  async notify(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = 5000,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      payload.params = params;
    }
    await this.postBody(JSON.stringify(payload), null, timeoutMs);
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
      const res = await fetch(this.target.url, {
        method: "DELETE",
        headers: this.buildHeaders(),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      await res.body?.cancel().catch(() => {});
    } catch {
      // Best-effort session teardown.
    }
  }
}
