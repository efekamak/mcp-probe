export type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type RawProbeResult = {
  received: boolean;
  timedOut: boolean;
  httpStatus?: number;
  contentType?: string;
  rawBody: string;
  parsed: JsonRpcResponse | null;
  transportError?: string;
};

export interface ProbeTransport {
  readonly kind: "stdio" | "http";
  connect(timeoutMs: number): Promise<void>;
  request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<RawProbeResult>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  sendRawJson(payload: unknown, expectId: number | null, timeoutMs: number): Promise<RawProbeResult>;
  sendRawText(raw: string, timeoutMs: number): Promise<RawProbeResult>;
  getStrayStdoutLines(): string[];
  getStderrExcerpt(): string;
  isAlive(): boolean;
  close(): Promise<void>;
}
