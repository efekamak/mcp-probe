import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { StdioTarget } from "../types.js";
import type { JsonRpcResponse, ProbeTransport, RawProbeResult } from "./types.js";

const MAX_STDERR_BYTES = 16_384;
const MAX_STRAY_LINES = 50;
const MAX_STDOUT_BUF_BYTES = 4 * 1024 * 1024;

let cachedNodePathKey: string | null = null;
let cachedNodePathPromise: Promise<string> | null = null;

function absolutePathDirs(): string[] {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const raw of pathEnv.split(path.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (dir.length === 0 || seen.has(dir) || !path.isAbsolute(dir)) {
      continue;
    }
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") {
      await fs.access(candidate, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

async function probeNodeVersion(nodePath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let out = "";
    let timer: NodeJS.Timeout | undefined;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    let child: ChildProcess;
    try {
      child = spawn(nodePath, ["--version"], {
        env: buildSafeChildEnv(),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      done(false);
      return;
    }
    timer = setTimeout(() => {
      killProcessTree(child.pid);
      done(false);
    }, 5000);
    child.stdout?.on("data", (c: Buffer) => {
      if (out.length < 64) out += c.toString("utf8");
    });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0 && /^v\d+\.\d+\.\d+/.test(out.trim())));
  });
}

async function findPreferredNode(): Promise<string> {
  const pathKey = process.env.PATH ?? process.env.Path ?? "";
  if (cachedNodePathPromise && cachedNodePathKey === pathKey) {
    return cachedNodePathPromise;
  }
  cachedNodePathKey = pathKey;
  cachedNodePathPromise = (async () => {
    const fileName = process.platform === "win32" ? "node.exe" : "node";
    for (const dir of absolutePathDirs()) {
      const candidate = path.join(dir, fileName);
      if ((await isExecutableFile(candidate)) && (await probeNodeVersion(candidate))) {
        return candidate;
      }
    }
    return process.execPath;
  })();
  return cachedNodePathPromise;
}

async function findNpmBinScript(
  nodePath: string,
  scriptName: "npm-cli.js" | "npx-cli.js",
): Promise<string | null> {
  const nodeDirs = [path.dirname(nodePath)];
  try {
    const realDir = path.dirname(await fs.realpath(nodePath));
    if (!nodeDirs.includes(realDir)) nodeDirs.push(realDir);
  } catch {
    // ignore
  }
  const hostDir = path.dirname(process.execPath);
  if (!nodeDirs.includes(hostDir)) nodeDirs.push(hostDir);

  for (const dir of [...nodeDirs, ...absolutePathDirs()]) {
    const candidates = [
      path.join(dir, "node_modules", "npm", "bin", scriptName),
      path.resolve(dir, "..", "lib", "node_modules", "npm", "bin", scriptName),
    ];
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  if (path.isAbsolute(command)) {
    return (await isExecutableFile(command)) ? command : null;
  }

  const names =
    process.platform === "win32"
      ? command.toLowerCase().endsWith(".exe")
        ? [command]
        : [`${command}.exe`, command]
      : [command];

  for (const dir of absolutePathDirs()) {
    if (process.platform === "win32") {
      const norm = dir.replace(/\\/g, "/").toLowerCase();
      if (norm.endsWith("/microsoft/windowsapps")) {
        continue;
      }
    }
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export async function resolveStdioCommand(
  command: string,
  args: string[],
): Promise<{ execPath: string; execArgs: string[] }> {
  if (command === "node") {
    return { execPath: await findPreferredNode(), execArgs: args };
  }
  if (command === "npm") {
    const nodePath = await findPreferredNode();
    const cli = await findNpmBinScript(nodePath, "npm-cli.js");
    if (cli) return { execPath: nodePath, execArgs: [cli, ...args] };
    return { execPath: "npm", execArgs: args };
  }
  if (command === "npx") {
    const nodePath = await findPreferredNode();
    const cli = await findNpmBinScript(nodePath, "npx-cli.js");
    if (cli) return { execPath: nodePath, execArgs: [cli, ...args] };
    return { execPath: "npx", execArgs: args };
  }
  if (command === "python" || command === "python3") {
    const found =
      (await findExecutableOnPath(process.platform === "win32" ? "python" : "python3")) ??
      (await findExecutableOnPath("python"));
    if (found) return { execPath: found, execArgs: args };
  }
  const resolved = await findExecutableOnPath(command);
  return { execPath: resolved ?? command, execArgs: args };
}

export function buildSafeChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const allowKeys = [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowKeys) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  env.NO_COLOR = "1";
  env.PYTHONUTF8 = "1";
  env.PYTHONUNBUFFERED = "1";
  env.npm_config_update_notifier = "false";
  env.npm_config_fund = "false";
  env.npm_config_audit = "false";

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      env[k] = v;
    }
  }
  return env;
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
      });
      killer.unref();
    } catch {
      // Best-effort cleanup.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

type PendingWaiter = {
  matchId: number | null;
  acceptAnyError: boolean;
  resolve: (res: RawProbeResult) => void;
  timer: NodeJS.Timeout;
};

export class StdioProbeTransport implements ProbeTransport {
  readonly kind = "stdio" as const;
  private readonly target: StdioTarget;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private stdoutBuf = "";
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrDecoder = new StringDecoder("utf8");
  private stderrChunks: string[] = [];
  private stderrBytes = 0;
  private strayStdoutLines: string[] = [];
  private exited = false;
  private exitError: string | null = null;
  private waiters: PendingWaiter[] = [];

  constructor(target: StdioTarget) {
    this.target = target;
  }

  async connect(timeoutMs: number): Promise<void> {
    const { execPath, execArgs } = await resolveStdioCommand(this.target.command, this.target.args);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const child = spawn(execPath, execArgs, {
        cwd: this.target.cwd ?? process.cwd(),
        env: buildSafeChildEnv(this.target.env),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      const timer = setTimeout(() => {
        killProcessTree(child.pid);
        done(new Error(`Timed out spawning stdio server after ${timeoutMs}ms.`));
      }, Math.min(timeoutMs, 15_000));

      child.on("spawn", () => done());
      child.on("error", (err) => {
        this.exited = true;
        this.exitError = err.message;
        this.failAllWaiters(`Process error: ${err.message}`);
        done(err);
      });
      child.on("close", (code, signal) => {
        this.exited = true;
        this.exitError = `Server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.failAllWaiters(this.exitError);
      });

      child.stdin?.on("error", (err) => {
        // Ignore EPIPE / broken pipe when a server crashes mid-probe; waiters fail on close.
        this.exitError = this.exitError ?? `stdin error: ${err.message}`;
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        this.handleStdoutChunk(this.stdoutDecoder.write(chunk));
      });
      child.stdout?.on("end", () => {
        const tail = this.stdoutDecoder.end();
        if (tail.length > 0) this.handleStdoutChunk(tail);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = this.stderrDecoder.write(chunk);
        if (this.stderrBytes < MAX_STDERR_BYTES) {
          this.stderrChunks.push(text);
          this.stderrBytes += Buffer.byteLength(text, "utf8");
        }
      });
      child.stderr?.on("end", () => {
        const tail = this.stderrDecoder.end();
        if (tail.length > 0 && this.stderrBytes < MAX_STDERR_BYTES) {
          this.stderrChunks.push(tail);
          this.stderrBytes += Buffer.byteLength(tail, "utf8");
        }
      });
    });
  }

  private failAllWaiters(reason: string): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        received: false,
        timedOut: false,
        rawBody: "",
        parsed: null,
        transportError: reason,
      });
    }
  }

  private handleStdoutChunk(text: string): void {
    this.stdoutBuf += text;
    let start = 0;
    let newlineIdx = this.stdoutBuf.indexOf("\n", start);

    while (newlineIdx !== -1) {
      const lineLen = newlineIdx - start;
      if (lineLen > MAX_STDOUT_BUF_BYTES) {
        if (this.strayStdoutLines.length < MAX_STRAY_LINES) {
          this.strayStdoutLines.push(
            `[oversized stdout frame dropped] ${this.stdoutBuf.slice(start, start + 120)}`,
          );
        }
        start = newlineIdx + 1;
        newlineIdx = this.stdoutBuf.indexOf("\n", start);
        continue;
      }

      const rawLine = this.stdoutBuf.slice(start, newlineIdx).replace(/\r$/, "");
      start = newlineIdx + 1;
      newlineIdx = this.stdoutBuf.indexOf("\n", start);

      const trimmed = rawLine.trim();
      if (trimmed.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        if (this.strayStdoutLines.length < MAX_STRAY_LINES) {
          this.strayStdoutLines.push(trimmed.slice(0, 300));
        }
        continue;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        if (this.strayStdoutLines.length < MAX_STRAY_LINES) {
          this.strayStdoutLines.push(trimmed.slice(0, 300));
        }
        continue;
      }

      const msg = parsed as JsonRpcResponse;
      if (msg.jsonrpc !== "2.0" && msg.result === undefined && msg.error === undefined) {
        if (this.strayStdoutLines.length < MAX_STRAY_LINES) {
          this.strayStdoutLines.push(trimmed.slice(0, 300));
        }
        continue;
      }

      this.dispatchMessage(trimmed, msg);
    }

    if (start > 0) {
      this.stdoutBuf = this.stdoutBuf.slice(start);
    }
    if (this.stdoutBuf.length > 0 && Buffer.byteLength(this.stdoutBuf, "utf8") > MAX_STDOUT_BUF_BYTES) {
      if (this.strayStdoutLines.length < MAX_STRAY_LINES) {
        this.strayStdoutLines.push(
          `[oversized unterminated stdout frame dropped] ${this.stdoutBuf.slice(0, 120)}`,
        );
      }
      this.stdoutBuf = "";
    }
  }

  private dispatchMessage(raw: string, msg: JsonRpcResponse): void {
    // Match exact id first.
    if (typeof msg.id === "number") {
      const idx = this.waiters.findIndex((w) => w.matchId === msg.id);
      if (idx !== -1) {
        const [waiter] = this.waiters.splice(idx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve({
          received: true,
          timedOut: false,
          rawBody: raw,
          parsed: msg,
        });
        return;
      }
    }

    // Match error-without-id (for example parse error with id: null or omitted id).
    if (msg.error !== undefined) {
      const idx = this.waiters.findIndex((w) => w.acceptAnyError);
      if (idx !== -1) {
        const [waiter] = this.waiters.splice(idx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve({
          received: true,
          timedOut: false,
          rawBody: raw,
          parsed: msg,
        });
      }
    }
  }

  private waitForResponse(
    matchId: number | null,
    acceptAnyError: boolean,
    timeoutMs: number,
  ): Promise<RawProbeResult> {
    if (this.exited) {
      return Promise.resolve({
        received: false,
        timedOut: false,
        rawBody: "",
        parsed: null,
        transportError: this.exitError ?? "Server process is not running.",
      });
    }

    return new Promise<RawProbeResult>((resolve) => {
      const waiter: PendingWaiter = {
        matchId,
        acceptAnyError,
        resolve,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          resolve({
            received: false,
            timedOut: true,
            rawBody: "",
            parsed: null,
          });
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.child?.stdin || this.exited) {
        reject(new Error(this.exitError ?? "Server stdin is not writable."));
        return;
      }
      this.child.stdin.write(`${line}\n`, "utf8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
    const waiter = this.waitForResponse(id, false, timeoutMs);
    try {
      await this.writeLine(JSON.stringify(payload));
    } catch (err) {
      this.failAllWaiters(err instanceof Error ? err.message : String(err));
    }
    return waiter;
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      payload.params = params;
    }
    await this.writeLine(JSON.stringify(payload));
  }

  async sendRawJson(
    payload: unknown,
    expectId: number | null,
    timeoutMs: number,
  ): Promise<RawProbeResult> {
    const waiter = this.waitForResponse(expectId, true, timeoutMs);
    try {
      await this.writeLine(JSON.stringify(payload));
    } catch (err) {
      this.failAllWaiters(err instanceof Error ? err.message : String(err));
    }
    return waiter;
  }

  async sendRawText(raw: string, timeoutMs: number): Promise<RawProbeResult> {
    const waiter = this.waitForResponse(null, true, timeoutMs);
    try {
      await this.writeLine(raw);
    } catch (err) {
      this.failAllWaiters(err instanceof Error ? err.message : String(err));
    }
    return waiter;
  }

  getStrayStdoutLines(): string[] {
    return [...this.strayStdoutLines];
  }

  getStderrExcerpt(): string {
    return this.stderrChunks.join("").trim();
  }

  isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  async close(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.failAllWaiters("Transport closed.");

    if (this.exited) return;

    try {
      child.stdin?.end();
    } catch {
      // ignore
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        resolve();
      };
      child.once("close", finish);
      const grace = setTimeout(() => {
        killProcessTree(child.pid);
        finish();
      }, 1500);
    });
  }
}
