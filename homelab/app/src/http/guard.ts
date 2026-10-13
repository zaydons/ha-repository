// Source-IP guard (design §7.2). Only the Supervisor ingress proxy and
// loopback may open a TCP connection. Fails closed: anything that can't be
// parsed is denied.
import { BlockList, isIP } from "node:net";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { Logger } from "../types.ts";

export const SUPERVISOR_IP = "172.30.32.2";
export const ALLOWED_SOURCES: readonly string[] = [SUPERVISOR_IP, "127.0.0.1", "::1"];

const DENY_LOG_INTERVAL_MS = 10 * 60 * 1000;
const DENY_LOG_MAX_ENTRIES = 1024;

const allowList = new BlockList();
allowList.addAddress(SUPERVISOR_IP, "ipv4");
allowList.addAddress("127.0.0.1", "ipv4");
allowList.addAddress("::1", "ipv6");

/**
 * Normalise a socket remoteAddress: lower-case, drop an IPv6 zone id, and turn
 * IPv4-mapped IPv6 ("::ffff:1.2.3.4" or "::ffff:102:304") into plain IPv4.
 * Returns null for anything that is not a valid IP address.
 */
export function normaliseAddress(addr: unknown): string | null {
  if (typeof addr !== "string") return null;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const zone = a.indexOf("%");
  if (zone !== -1) a = a.slice(0, zone);
  if (a.length === 0 || a.length > 64) return null;

  const family = isIP(a);
  if (family === 4) return a;
  if (family !== 6) return null;

  const groups = expandIPv6(a);
  if (groups === null) return null;
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return a;
}

/** Expand a valid IPv6 address (as accepted by net.isIP) into its 8 16-bit groups. */
function expandIPv6(a: string): number[] | null {
  let s = a;
  // A dotted IPv4 tail becomes two hex groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const o = dotted[2]!.split(".").map(Number);
    s = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const nums = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

/** True only for the Supervisor and loopback. Any error or unparsable input denies. */
export function isAllowedSource(addr: unknown): boolean {
  try {
    const a = normaliseAddress(addr);
    if (a === null) return false;
    const family = isIP(a) === 4 ? "ipv4" : "ipv6";
    return allowList.check(a, family);
  } catch {
    return false;
  }
}

export interface GuardOptions {
  /** HL_ALLOW_ANY_SOURCE=1 (env only): disables the guard for local QA. */
  allowAnySource: boolean;
  log: Logger;
}

/** The parts of a server the guard needs (an EventEmitter in tests). */
export type GuardableServer = Pick<Server, "prependListener">;

/**
 * Install the guard on a server before listen(). The listener is prepended so
 * it runs before node:http's own connection handler; a denied socket is
 * destroyed before any byte of the request is parsed.
 */
export function attachGuard(server: GuardableServer, opts: GuardOptions): void {
  if (opts.allowAnySource) {
    opts.log.warn("HL_ALLOW_ANY_SOURCE=1: source-IP guard is OFF. Use only for local testing, never in Home Assistant.");
    return;
  }
  const lastLogged = new Map<string, number>();
  server.prependListener("connection", (socket: Socket) => {
    let allowed = false;
    try {
      allowed = isAllowedSource(socket.remoteAddress);
    } catch {
      allowed = false;
    }
    if (allowed) return;
    socket.destroy();

    const key = normaliseAddress(socket.remoteAddress) ?? "unknown";
    const now = Date.now();
    const last = lastLogged.get(key);
    if (last === undefined || now - last >= DENY_LOG_INTERVAL_MS) {
      if (lastLogged.size >= DENY_LOG_MAX_ENTRIES) lastLogged.clear();
      lastLogged.set(key, now);
      opts.log.warn(`Dropped connection from ${key}: only the Supervisor (${SUPERVISOR_IP}) and loopback may connect`);
    }
  });
}
