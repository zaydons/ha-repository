// ICMP ping check (design §4.7). Runs iputils `ping` via execFile (never a
// shell) as the unprivileged `node` user: iputils uses ICMP datagram sockets,
// which Docker allows through net.ipv4.ping_group_range, so no NET_RAW or
// other capability is needed.
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { checkFailed } from "./types.ts";
import type { CheckOutcome } from "./types.ts";

export const PING_TIMEOUT_MS = 5000;
const PING_WAIT_S = "2";

export interface PingTarget {
  host: string;
  ipv6: boolean;
}

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.?$`);

/**
 * Validate a `ping:` value: a hostname, IPv4 or IPv6 address. Homepage users
 * sometimes write a URL; its hostname is used. Returns null when invalid
 * (including anything that could be read as a ping option, e.g. "-f").
 */
export function parsePingTarget(raw: unknown): PingTarget | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim();
  if (/^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^\[(.*)\]$/, "$1");
  if (host.length === 0 || host.length > 253 || host.startsWith("-")) return null;
  const ip = isIP(host);
  if (ip === 4) return { host, ipv6: false };
  if (ip === 6) return { host, ipv6: true };
  if (/^[0-9.]+$/.test(host)) return null; // looks like a malformed IPv4
  return HOSTNAME_RE.test(host) ? { host, ipv6: false } : null;
}

export function pingArgs(target: PingTarget): string[] {
  const args = ["-c", "1", "-W", PING_WAIT_S, "-n"];
  if (target.ipv6) args.push("-6");
  args.push(target.host);
  return args;
}

export interface ExecResult {
  /** Process exit code; null when killed (timeout) or never started. */
  exitCode: number | null;
  /** Spawn error code (ENOENT, EACCES, EPERM, ABORT_ERR), if any. */
  spawnError?: string;
  killed: boolean;
  stdout: string;
  stderr: string;
}

export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<ExecResult>;

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolveExec) => {
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        windowsHide: true,
        signal: opts.signal,
        env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errText = String(stderr ?? "");
        if (!err) {
          resolveExec({ exitCode: 0, killed: false, stdout: out, stderr: errText });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        if (typeof e.code === "number") {
          resolveExec({ exitCode: e.code, killed: Boolean(e.killed), stdout: out, stderr: errText });
        } else {
          const code = typeof e.code === "string" ? e.code : e.name === "AbortError" ? "ABORT_ERR" : "ERROR";
          resolveExec({ exitCode: null, spawnError: code, killed: Boolean(e.killed), stdout: out, stderr: errText });
        }
      },
    );
  });

const DNS_RE = /unknown host|name or service not known|name does not resolve|temporary failure in name resolution|cannot resolve|bad address|no address associated|nodename nor servname/i;
const PERM_RE = /operation not permitted|permission denied|lacking privilege|socktype|address family not supported/i;
const TIME_RE = /time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i;

export interface PingOptions {
  exec?: ExecFn;
  /** Binary name or path. Default "ping". */
  binary?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Run one ping check. Never throws. */
export async function checkPing(raw: string, opts: PingOptions = {}): Promise<CheckOutcome> {
  const target = parsePingTarget(raw);
  if (!target) return checkFailed("ping", "invalid_host");
  const exec = opts.exec ?? defaultExec;
  let r: ExecResult;
  try {
    r = await exec(opts.binary ?? "ping", pingArgs(target), { timeoutMs: opts.timeoutMs ?? PING_TIMEOUT_MS, signal: opts.signal });
  } catch {
    return checkFailed("ping", "exec_failed", target.host);
  }
  const host = target.host;
  if (r.spawnError) {
    if (r.spawnError === "ABORT_ERR") return checkFailed("ping", "cancelled", host);
    // ENOENT (no ping binary), EACCES/EPERM (not allowed to run it).
    return checkFailed("ping", r.spawnError, host);
  }
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.exitCode === 0) {
    const out: CheckOutcome = { state: "up", kind: "ping", host };
    const m = TIME_RE.exec(r.stdout);
    if (m) out.latencyMs = Math.round(Number(m[1]));
    return out;
  }
  if (r.killed) return { state: "down", kind: "ping", reason: "timeout", host };
  if (DNS_RE.test(text)) return { state: "down", kind: "ping", reason: "dns", host };
  // ICMP socket not permitted (ping_group_range excludes us): our failure, not the target's.
  if (PERM_RE.test(text)) return checkFailed("ping", "icmp_not_permitted", host);
  return { state: "down", kind: "ping", reason: "ping", host };
}
