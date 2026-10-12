// TrueNAS. Fields and labels match Homepage's truenas widget.
//
// version 1 (default): REST API, TrueNAS before 26.04.
//   https://www.truenas.com/docs/api/rest.html
//   GET /api/v2.0/system/info  -> loadavg[0], uptime_seconds
//   GET /api/v2.0/alert/list   -> count of alerts with dismissed === false
//   Auth: "Authorization: Bearer <key>", or Basic with username + password.
// version 2: JSON-RPC 2.0 over WebSocket at /api/current, TrueNAS 25.04+.
//   https://api.truenas.com/ (auth.login_with_api_key, auth.login_ex,
//   system.info, alert.list)
//   When an API key is used the connection is always wss://: TrueNAS revokes
//   an API key that is sent over an insecure transport.
//
// enablePools and nasType are accepted for Homepage compatibility; the pool
// list is not shown in v1 (one stat row per tile).
import { WidgetError } from "./types.ts";
import type { WidgetConfig, WidgetContext, WidgetNetPolicy, WidgetPlugin, WidgetValue } from "./types.ts";
import { countWhere, expectArray, expectRecord, pickFields, round, toNumber, wants } from "./lib/format.ts";
import { joinUrl } from "./lib/http-client.ts";
import { RPC_METHOD_NOT_FOUND, RpcCallError, withRpcSession } from "./lib/ws-rpc.ts";
import type { RpcSession } from "./lib/ws-rpc.ts";

const DEFAULT_TIMEOUT_S = 10;

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

interface Creds {
  key: string | null;
  username: string | null;
  password: string | null;
}

function credsOf(cfg: WidgetConfig): Creds {
  return { key: str(cfg.key)?.trim() || null, username: str(cfg.username), password: str(cfg.password) };
}

/** 1 or 2; null when the value is invalid. Absent = 1 (Homepage default). */
export function versionOf(cfg: WidgetConfig): 1 | 2 | null {
  const v = cfg.version;
  if (v === undefined || v === null) return 1;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*[12]\s*$/.test(v) ? Number(v) : NaN;
  return n === 1 || n === 2 ? n : null;
}

function validate(cfg: WidgetConfig): string | null {
  if (versionOf(cfg) === null) return "`version:` must be 1 or 2";
  const c = credsOf(cfg);
  if (!c.key && !(c.username && c.password)) return "needs `key:` or `username:` and `password:`";
  return null;
}

function computeValues(
  fields: readonly string[],
  info: Record<string, unknown> | null,
  alerts: unknown[] | null,
): Record<string, WidgetValue> {
  let load: number | null = null;
  let uptime: number | null = null;
  if (info) {
    const avg = Array.isArray(info.loadavg) ? info.loadavg : null;
    load = round(toNumber(avg?.[0]), 2);
    const up = toNumber(info.uptime_seconds);
    uptime = up === null ? null : Math.max(0, Math.floor(up));
  }
  const values: Record<string, WidgetValue> = {
    load,
    uptime,
    alerts: alerts ? countWhere(alerts, (a) => a.dismissed === false) : null,
  };
  return pickFields(values, fields);
}

// --- version 1: REST ---------------------------------------------------------

async function fetchRest(ctx: WidgetContext, c: Creds): Promise<Record<string, WidgetValue>> {
  const authorization = c.key
    ? `Bearer ${c.key}`
    : `Basic ${Buffer.from(`${c.username ?? ""}:${c.password ?? ""}`, "utf8").toString("base64")}`;
  const headers = { Authorization: authorization };
  const f = ctx.fields;
  const [info, alerts] = await Promise.all([
    wants(f, "load", "uptime")
      ? ctx.http.json("/api/v2.0/system/info", { headers }).then((b) => expectRecord(b, "system/info"))
      : null,
    wants(f, "alerts")
      ? ctx.http.json("/api/v2.0/alert/list", { headers }).then((b) => expectArray(b, "alert/list"))
      : null,
  ]);
  return computeValues(f, info, alerts);
}

// --- version 2: WebSocket JSON-RPC ---------------------------------------------

/** The WebSocket endpoint for cfg.url: https -> wss, http -> ws (wss when a key is used). */
export function wsUrlFor(cfgUrl: unknown, usesKey: boolean): URL {
  if (typeof cfgUrl !== "string" || cfgUrl === "") throw new WidgetError("config", "needs `url:`");
  let u: URL;
  try {
    u = new URL(cfgUrl);
  } catch {
    throw new WidgetError("config", "The widget url isn't a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new WidgetError("config", "The widget url must start with http:// or https://");
  }
  if (u.username || u.password) {
    throw new WidgetError("config", "The widget url must not contain user:password@; use the widget's credential keys");
  }
  u.hash = "";
  u.search = "";
  u.protocol = u.protocol === "https:" || usesKey ? "wss:" : "ws:";
  return joinUrl(u, "/api/current");
}

function netPolicy(ctx: WidgetContext, c: Creds): WidgetNetPolicy {
  if (ctx.net) {
    return { ...ctx.net, secrets: [...ctx.net.secrets, ...[c.key, c.username, c.password].filter((s): s is string => !!s)] };
  }
  // Fallback when the scheduler doesn't provide the policy: the widget's own
  // tlsVerify (default off, as everywhere) and the default timeout.
  return {
    tlsVerify: ctx.cfg.tlsVerify === true,
    timeoutS: DEFAULT_TIMEOUT_S,
    secrets: [c.key, c.username, c.password].filter((s): s is string => !!s),
  };
}

function isMethodNotFound(err: unknown): boolean {
  return err instanceof RpcCallError && err.rpcCode === RPC_METHOD_NOT_FOUND;
}

/** Logs in; throws WidgetError("auth") when TrueNAS refuses the credentials. */
async function login(s: RpcSession, c: Creds): Promise<void> {
  if (c.key && c.username) {
    const r = await s.call<unknown>("auth.login_ex", [{ mechanism: "API_KEY_PLAIN", username: c.username, api_key: c.key }]);
    return checkLoginEx(r);
  }
  if (c.key) {
    let ok: unknown;
    try {
      ok = await s.call<unknown>("auth.login_with_api_key", [c.key]);
    } catch (err) {
      if (isMethodNotFound(err)) {
        // Removed in TrueNAS 27: API_KEY_PLAIN via auth.login_ex needs the key owner's user name.
        throw new WidgetError("config", "This TrueNAS version needs `username:` (the API key's owner) next to `key:`");
      }
      throw err;
    }
    if (ok !== true) throw new WidgetError("auth", "TrueNAS rejected the API key");
    return;
  }
  try {
    const r = await s.call<unknown>("auth.login_ex", [
      { mechanism: "PASSWORD_PLAIN", username: c.username, password: c.password },
    ]);
    return checkLoginEx(r);
  } catch (err) {
    if (!isMethodNotFound(err)) throw err;
  }
  const ok = await s.call<unknown>("auth.login", [c.username, c.password]);
  if (ok !== true) throw new WidgetError("auth", "TrueNAS rejected the user name or password");
}

function checkLoginEx(r: unknown): void {
  const type = typeof r === "object" && r !== null ? (r as Record<string, unknown>).response_type : undefined;
  if (type === "SUCCESS") return;
  if (type === "OTP_REQUIRED") throw new WidgetError("auth", "TrueNAS asks for a one-time password; use an API key");
  if (typeof type === "string") throw new WidgetError("auth", `TrueNAS login refused (${type.slice(0, 32)})`);
  throw new WidgetError("bad_response", "auth.login_ex: unexpected answer");
}

async function fetchWs(ctx: WidgetContext, c: Creds): Promise<Record<string, WidgetValue>> {
  const url = wsUrlFor(ctx.cfg.url, c.key !== null);
  const net = netPolicy(ctx, c);
  const f = ctx.fields;
  return withRpcSession(
    { url, tlsVerify: net.tlsVerify, ca: net.ca, timeoutS: net.timeoutS, secrets: net.secrets, signal: ctx.signal, log: ctx.log },
    async (s) => {
      await login(s, c);
      const [info, alerts] = await Promise.all([
        wants(f, "load", "uptime") ? s.call("system.info").then((b) => expectRecord(b, "system.info")) : null,
        wants(f, "alerts") ? s.call("alert.list").then((b) => expectArray(b, "alert.list")) : null,
      ]);
      return computeValues(f, info, alerts);
    },
  );
}

export const truenas: WidgetPlugin = {
  type: "truenas",
  fields: [
    { key: "load", label: "System Load", format: "number" },
    { key: "uptime", label: "Uptime", format: "duration" },
    { key: "alerts", label: "Alerts", format: "number" },
  ],
  defaultFields: ["load", "uptime", "alerts"],
  configKeys: {
    required: ["url"],
    optional: ["key", "username", "password", "version", "enablePools", "nasType"],
    secret: ["key", "username", "password"],
  },
  validate,
  async fetch(ctx) {
    const problem = validate(ctx.cfg);
    if (problem) throw new WidgetError("config", problem);
    const c = credsOf(ctx.cfg);
    return versionOf(ctx.cfg) === 2 ? fetchWs(ctx, c) : fetchRest(ctx, c);
  },
};
