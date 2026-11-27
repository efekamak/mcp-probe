// Linear-time ANSI CSI, OSC (BEL or ST terminated), and 2-byte ESC stripper.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX =
  /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)?|\[[0-?]*[ -/]*[@-~]|[@-Z\\^_])|\x9B[0-?]*[ -/]*[@-~]/g;

const BEGIN_PRIVATE_KEY_REGEX = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const END_PRIVATE_KEY_REGEX = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;

function redactPrivateKeys(text: string): string {
  if (!text.includes("PRIVATE KEY-----")) return text;
  let out = "";
  let cursor = 0;
  let noMoreEndMarkers = false;

  while (cursor < text.length) {
    BEGIN_PRIVATE_KEY_REGEX.lastIndex = cursor;
    const beginMatch = BEGIN_PRIVATE_KEY_REGEX.exec(text);
    if (!beginMatch) break;

    out += text.slice(cursor, beginMatch.index);
    const afterBegin = beginMatch.index + beginMatch[0].length;
    let endMatch: RegExpExecArray | null = null;
    if (!noMoreEndMarkers) {
      END_PRIVATE_KEY_REGEX.lastIndex = afterBegin;
      endMatch = END_PRIVATE_KEY_REGEX.exec(text);
      if (!endMatch) noMoreEndMarkers = true;
    }

    if (endMatch) {
      out += "[REDACTED_PRIVATE_KEY]";
      cursor = endMatch.index + endMatch[0].length;
      continue;
    }

    // Truncated/unclosed PEM block: redact contiguous base64/PEM-header body lines in O(N).
    let endIdx = afterBegin;
    while (endIdx < text.length) {
      const nl = text.indexOf("\n", endIdx);
      const lineEnd = nl === -1 ? text.length : nl + 1;
      const line = text.slice(endIdx, nl === -1 ? text.length : nl).trim();
      if (
        line.length === 0 ||
        /^[A-Za-z0-9+/=]{2,}$/.test(line) ||
        /^(?:Proc-Type|DEK-Info):/i.test(line)
      ) {
        endIdx = lineEnd;
      } else {
        break;
      }
    }
    out += "[REDACTED_PRIVATE_KEY]";
    cursor = endIdx;
  }

  return cursor === 0 ? text : out + text.slice(cursor);
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})\b/g, replacement: "[REDACTED_KEY]" },
  { pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, replacement: "[REDACTED_GH_TOKEN]" },
  { pattern: /\b(github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: "[REDACTED_GH_TOKEN]" },
  { pattern: /\b(npm_[A-Za-z0-9]{20,})\b/g, replacement: "[REDACTED_NPM_TOKEN]" },
  { pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /\b(xox[baprsce]-[A-Za-z0-9-]{10,})\b/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  {
    pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    replacement: "[REDACTED_JWT]",
  },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replacement: "$1[REDACTED_TOKEN]" },
  { pattern: /(\bBasic\s+)[A-Za-z0-9+/=]{8,}/gi, replacement: "$1[REDACTED_TOKEN]" },
  { pattern: /(https?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, replacement: "$1[REDACTED]@" },
  { pattern: /([?&](?:api_?key|token|access_?token|secret|auth|key)=)[^&\s"'`]+/gi, replacement: "$1[REDACTED]" },
];

const LOCAL_PATH_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /[A-Za-z]:\\Users\\[^\\\s"'`<>|]+/g, replacement: "<user-home>" },
  { pattern: /[A-Za-z]:\/Users\/[^/\s"'`<>|]+/g, replacement: "<user-home>" },
  { pattern: /\/Users\/[^/\s"'`<>|]+/g, replacement: "<user-home>" },
  { pattern: /\/home\/[^/\s"'`<>|]+/g, replacement: "<user-home>" },
];

export function stripAnsi(text: string): string {
  if (typeof text !== "string") return "";
  return text.replace(ANSI_REGEX, "");
}

export function scrubText(text: string, maxLen: number = 1024): string {
  let out = redactPrivateKeys(stripAnsi(text));
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  for (const { pattern, replacement } of LOCAL_PATH_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > maxLen) {
    return `${out.slice(0, maxLen)}... [truncated]`;
  }
  return out;
}

export function detectSecretOrPathLeak(text: string): string[] {
  const clean = stripAnsi(text);
  const leaks: string[] = [];
  BEGIN_PRIVATE_KEY_REGEX.lastIndex = 0;
  if (BEGIN_PRIVATE_KEY_REGEX.test(clean)) {
    leaks.push("secret-like token pattern");
  } else {
    for (const { pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(clean)) {
        leaks.push("secret-like token pattern");
        break;
      }
    }
  }
  for (const { pattern } of LOCAL_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(clean)) {
      leaks.push("host user filesystem path");
      break;
    }
  }
  return leaks;
}
