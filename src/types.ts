export type TransportKind = "stdio" | "http";

export type CheckCategory = "protocol" | "schema" | "context" | "safety";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export type ProviderId = "openai" | "anthropic" | "gemini" | "cursor";

export type Grade = "A" | "B" | "C" | "D" | "F";

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type McpPromptArgument = {
  name: string;
  description?: string;
  required?: boolean;
};

export type McpPrompt = {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
};

export type McpResource = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type McpServerInfo = {
  name: string | null;
  version: string | null;
  protocolVersion: string | null;
  capabilities: string[];
};

export type CheckResult = {
  id: string;
  category: CheckCategory;
  title: string;
  status: CheckStatus;
  summary: string;
  details?: string[];
};

export type ProviderIssue = {
  tool: string;
  rule: string;
  severity: "fail" | "warn";
  message: string;
  path?: string;
  fix?: string;
};

export type ProviderCompatibility = {
  provider: ProviderId;
  compatible: boolean;
  compatibleTools: number;
  totalTools: number;
  errors: number;
  warnings: number;
  issues: ProviderIssue[];
};

export type ToolTokenEntry = {
  name: string;
  bytes: number;
  estimatedTokens: number;
  hasDescription: boolean;
  hasAnnotations: boolean;
};

export type ContextBudgetSummary = {
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  totalBytes: number;
  estimatedTokens: number;
  missingDescriptions: number;
  missingAnnotations: number;
  heaviestTools: ToolTokenEntry[];
};

export type SafetyFinding = {
  tool: string | null;
  rule: string;
  severity: "fail" | "warn";
  message: string;
  excerpt?: string;
};

export type SafetySummary = {
  passed: boolean;
  errors: number;
  warnings: number;
  findings: SafetyFinding[];
};

export type AuditReport = {
  schemaVersion: 1;
  tool: "mcp-probe";
  toolVersion: string;
  timestamp: string;
  durationMs: number;
  target: {
    transport: TransportKind;
    display: string;
  };
  server: McpServerInfo;
  score: number;
  grade: Grade;
  status: "passed" | "warned" | "failed" | "error";
  counts: {
    pass: number;
    warn: number;
    fail: number;
    skip: number;
  };
  checks: CheckResult[];
  providers: Record<ProviderId, ProviderCompatibility>;
  context: ContextBudgetSummary;
  safety: SafetySummary;
  rawErrorExcerpts?: string[];
  fatalError: string | null;
};

export type StdioTarget = {
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type HttpTarget = {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
};

export type ProbeTarget = StdioTarget | HttpTarget;

export type ProbeOptions = {
  timeoutMs?: number;
  stepTimeoutMs?: number;
  failOnWarn?: boolean;
};
