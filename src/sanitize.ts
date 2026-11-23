const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(sk-[A-Za-z0-9_-]{16,})\b/g, replacement: "[REDACTED_KEY]" },
  { pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, replacement: "[REDACTED_GH_TOKEN]" },
  { pattern: /\b(github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: "[REDACTED_GH_TOKEN]" },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replacement: "$1[REDACTED_TOKEN]" },
  { pattern: /(https?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, replacement: "$1[REDACTED]@" },
];

const LOCAL_PATH_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /[A-Za-z]:\\Users\\[^\\\s"'`<>|]+/g, replacement: "<user-home>" },
  { pattern: /[A-Za-z]:\/Users\/[^/\s"'`<>|]+/g, replacement: "<user-home>" },
  { pattern: /\/Users\/[^/\s"'`<>|]+/g, replacement: "<user-home>" },
  { pattern: /\/home\/[^/\s"'`<>|]+/g, replacement: "<user-home>" },
];

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function scrubText(text: string, maxLen: number = 1024): string {
  let out = stripAnsi(text);
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
  const leaks: string[] = [];
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      leaks.push("secret-like token pattern");
      break;
    }
  }
  for (const { pattern } of LOCAL_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      leaks.push("host user filesystem path");
      break;
    }
  }
  return leaks;
}
