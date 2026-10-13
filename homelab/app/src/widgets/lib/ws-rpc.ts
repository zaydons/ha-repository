// Minimal JSON-RPC 2.0 over WebSocket client for widget plugins (TrueNAS v2).
// Design §4.6 (truenas) and §7.4. Same guarantees as HttpClient:
// - connects only to the URL the plugin derives from cfg.url; redirects are
//   never followed (an HTTP answer to the upgrade is an error);
// - TLS policy from tlsOptions() (default off, owner decision Q3);
// - one deadline for the whole session (connect plus every call), and the
//   caller's AbortSignal cancels it;
// - messages are capped (10 MB) and permessage-deflate is off;
// - errors are WidgetErrors with the central network mapping and redacted
//   text; logs carry method names and timings, never params or results;
// - the socket is always closed: a clean close (1000) after success, an
//   immediate terminate on failure, timeout or abort.
import WebSocket from "ws";
import type { RawData } from "ws";
import type { Logger } from "../../types.ts";
import { redact } from "../../redact.ts";
import { WidgetError } from "../types.ts";
import { mapNetworkError, tlsOptions } from "./http-client.ts";
import type { TlsPolicy } from "./http-client.ts";

export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
/** After a clean close() the peer gets this long to answer before the socket is terminated. */
export const CLOSE_GRACE_MS = 1000;
const USER_AGENT = "HomelabDashboard";
const MAX_DETAIL = 200;

/** JSON-RPC "method not found". */
export const RPC_METHOD_NOT_FOUND = -32601;

/** A JSON-RPC error answer. kind is "auth" for permission errors, else "bad_response". */
export class RpcCallError extends WidgetError {
  rpcCode: number | undefined;
  /** Vendor error name when present (TrueNAS: error.data.errname, e.g. "EACCES"). */
  errname: string | undefined;

  constructor(kind: "auth" | "bad_response", message: string, rpcCode?: number, errname?: string) {
    super(kind, message);
    this.name = "RpcCallError";
    this.rpcCode = rpcCode;
    this.errname = errname;
  }
}

export interface RpcOptions extends TlsPolicy {
  /** ws: or wss: URL. */
  url: URL;
  /** Whole-session budget in seconds. */
  timeoutS: number;
  signal?: AbortSignal;
  /** Resolved secret values, redacted from every message and log line. */
  secrets?: readonly string[];
  log?: Logger;
  /** Tests only. Default MAX_MESSAGE_BYTES. */
  maxMessageBytes?: number;
}

export interface RpcSession {
  /** Sends one JSON-RPC request and resolves with its `result`. */
  call<T = unknown>(method: string, params?: unknown[] | Record<string, unknown>): Promise<T>;
}

const AUTH_ERRNAMES = new Set(["EACCES", "EPERM", "ENOTAUTHENTICATED", "EAUTH"]);

function clean(text: string, secrets: readonly string[]): string {
  return redact(text, secrets).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_DETAIL);
}

/** Maps a JSON-RPC error object to an RpcCallError (redacted, capped). */
export function rpcError(method: string, err: unknown, secrets: readonly string[] = []): RpcCallError {
  const e = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const code = typeof e.code === "number" ? e.code : undefined;
  const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<string, unknown>;
  const errname = typeof data.errname === "string" ? data.errname : undefined;
  const reason = typeof data.reason === "string" ? data.reason : typeof e.message === "string" ? e.message : "";
  const isAuth =
    (errname !== undefined && AUTH_ERRNAMES.has(errname)) || /not authenticated|permission denied|not authori[sz]ed/i.test(reason);
  const label = code === RPC_METHOD_NOT_FOUND ? "method not found" : errname ?? (code !== undefined ? `error ${code}` : "error");
  const detail = reason ? `: ${clean(reason, secrets)}` : "";
  return new RpcCallError(isAuth ? "auth" : "bad_response", `${method}: ${label}${detail}`, code, errname);
}

function wsErrorToWidgetError(err: unknown, secrets: readonly string[], maxBytes: number): WidgetError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    return new WidgetError("bad_response", `WebSocket message larger than ${maxBytes} bytes`);
  }
  if (typeof code === "string" && code.startsWith("WS_ERR_")) {
    return new WidgetError("bad_response", `WebSocket protocol error (${code})`);
  }
  const we = mapNetworkError(err, secrets);
  we.message = clean(we.message, secrets);
  return we;
}

function dataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

interface Pending {
  method: string;
  started: number;
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

/**
 * Opens a session, runs `fn`, and always closes the socket. Every failure is a
 * WidgetError (redacted). `fn` should only await `session.call()`s.
 */
export async function withRpcSession<T>(opts: RpcOptions, fn: (s: RpcSession) => Promise<T>): Promise<T> {
  const secrets = opts.secrets ?? [];
  const log = opts.log;
  const maxBytes = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const timeoutMs = Math.max(1, opts.timeoutS * 1000);
  const where = clean(`${opts.url.host}${opts.url.pathname}`, secrets);
  if (opts.url.protocol !== "ws:" && opts.url.protocol !== "wss:") {
    throw new WidgetError("config", "WebSocket URL must be ws:// or wss://");
  }
  if (opts.url.username || opts.url.password) {
    throw new WidgetError("config", "The widget url must not contain user:password@; use the widget's credential keys");
  }
  if (opts.signal?.aborted) throw new WidgetError("timeout", "Request cancelled");

  let fatal: WidgetError | null = null;
  let done = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let rejectFatal: (e: WidgetError) => void = () => {};
  const fatalPromise = new Promise<never>((_, reject) => {
    rejectFatal = reject;
  });
  fatalPromise.catch(() => {}); // observed via Promise.race below

  const ws = new WebSocket(opts.url, {
    handshakeTimeout: timeoutMs,
    maxPayload: maxBytes,
    perMessageDeflate: false,
    followRedirects: false,
    headers: { "user-agent": USER_AGENT },
    ...(opts.url.protocol === "wss:" ? tlsOptions(opts) : {}),
  });

  let closeTimer: NodeJS.Timeout | undefined;
  const fail = (err: WidgetError): void => {
    if (fatal || done) return;
    fatal = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    rejectFatal(err);
    ws.terminate();
  };

  const timer = setTimeout(() => fail(new WidgetError("timeout", `Timed out after ${timeoutMs / 1000} s`)), timeoutMs);
  const onAbort = (): void => fail(new WidgetError("timeout", "Request cancelled"));
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  // Listeners stay attached for the socket's lifetime, so a late error never goes unhandled.
  ws.on("error", (err) => fail(wsErrorToWidgetError(err, secrets, maxBytes)));
  ws.on("unexpected-response", (_req, res) => {
    const status = res.statusCode ?? 0;
    res.resume();
    if (status === 401 || status === 403) fail(new WidgetError("auth", `WebSocket ${where}: HTTP ${status}`, status));
    else if (status >= 300 && status < 400) {
      fail(new WidgetError("bad_response", `WebSocket ${where}: HTTP ${status} redirect not followed`, status));
    } else fail(new WidgetError("bad_response", `WebSocket ${where}: HTTP ${status}, not a WebSocket endpoint`, status));
  });
  ws.on("close", (code) => {
    clearTimeout(closeTimer);
    fail(new WidgetError("unreachable", `WebSocket closed by the server (code ${code})`, undefined, `ws_close_${code}`));
  });
  ws.on("message", (data) => {
    if (fatal || done) return;
    let msg: unknown;
    try {
      msg = JSON.parse(dataToString(data));
    } catch {
      fail(new WidgetError("bad_response", "WebSocket message isn't JSON"));
      return;
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      fail(new WidgetError("bad_response", "WebSocket message isn't a JSON-RPC object"));
      return;
    }
    const m = msg as Record<string, unknown>;
    if (typeof m.id !== "number") {
      // Notifications (no id) are ignored; an error with a null id means the server couldn't parse our request.
      if ("error" in m && m.id === null) fail(rpcError("request", m.error, secrets));
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    const ms = Date.now() - p.started;
    if ("error" in m && m.error !== undefined && m.error !== null) {
      const e = rpcError(p.method, m.error, secrets);
      log?.debug(clean(`RPC ${p.method} -> ${e.kind} (${ms} ms)`, secrets), { host: opts.url.host });
      p.reject(e);
    } else if ("result" in m) {
      log?.debug(clean(`RPC ${p.method} -> ok (${ms} ms)`, secrets), { host: opts.url.host });
      p.resolve(m.result);
    } else {
      p.reject(new WidgetError("bad_response", `${p.method}: answer has neither result nor error`));
    }
  });

  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));

  const session: RpcSession = {
    call<R = unknown>(method: string, params: unknown[] | Record<string, unknown> = []): Promise<R> {
      if (fatal) return Promise.reject(fatal);
      if (done) return Promise.reject(new WidgetError("bad_response", "RPC session already closed"));
      const id = nextId++;
      const p = new Promise<R>((resolve, reject) => {
        pending.set(id, { method, started: Date.now(), resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (err) => {
          if (err) fail(wsErrorToWidgetError(err, secrets, maxBytes));
        });
      });
      p.catch(() => {}); // a call the plugin didn't await must not become an unhandled rejection
      return p;
    },
  };

  const started = Date.now();
  try {
    await Promise.race([opened, fatalPromise]);
    log?.debug(clean(`WebSocket ${where} open (${Date.now() - started} ms)`, secrets), { host: opts.url.host });
    return await Promise.race([fn(session), fatalPromise]);
  } catch (err) {
    if (err instanceof WidgetError) {
      err.message = clean(err.message, secrets);
      throw err;
    }
    throw wsErrorToWidgetError(err, secrets, maxBytes);
  } finally {
    done = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    for (const p of pending.values()) p.reject(new WidgetError("bad_response", "RPC session closed"));
    pending.clear();
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000);
      closeTimer = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
      closeTimer.unref();
    } else if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  }
}
