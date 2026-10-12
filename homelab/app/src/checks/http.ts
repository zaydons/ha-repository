// siteMonitor check (design §4.7, Homepage parity):
// HEAD with a 5 s timeout; if the status is > 403 or HEAD fails with a
// protocol-level error, retry once with GET (body discarded after headers).
// Up iff the final status is <= 403 (401/403 = alive behind auth; 3xx = up,
// redirects are never followed). Latency is time to response headers.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { rootCertificates } from "node:tls";
import type { StatusReason } from "../types.ts";
import { redact } from "../redact.ts";
import { checkFailed } from "./types.ts";
import type { CheckOutcome } from "./types.ts";

export const HTTP_CHECK_TIMEOUT_MS = 5000;
/** Highest status that still counts as "up" (Homepage parity). */
export const MAX_UP_STATUS = 403;
const USER_AGENT = "HomelabDashboard/1 (status check)";

export interface HttpCheckOptions {
  /** Verify the server certificate (settings.yaml tlsVerify; default false). */
  tlsVerify: boolean;
  /** Extra trusted CA bundle (/config/ca.pem), added to the system CAs. */
  ca?: string | Buffer;
  /** Per attempt. Default 5 s. */
  timeoutMs?: number;
  /** Cancels the check (config reload / shutdown). */
  signal?: AbortSignal;
  /** Resolved secrets, for redacting `detail`. */
  secrets?: readonly string[];
  /** Monotonic clock in ms (tests). */
  clock?: () => number;
}

type Attempt =
  | { ok: true; status: number; latencyMs: number }
  | { ok: false; code: string; timedOut: boolean; aborted: boolean };

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "EAI_NODATA"]);
/** Errors after which a GET retry is worth it (server mishandles HEAD). */
const PROTOCOL_CODES = new Set(["ECONNRESET", "EPIPE", "ERR_INVALID_HTTP_RESPONSE"]);

export function isTlsErrorCode(code: string): boolean {
  return (
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_") ||
    code.startsWith("UNABLE_TO_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "HOSTNAME_MISMATCH" ||
    code === "EPROTO"
  );
}

function isProtocolError(code: string): boolean {
  return code.startsWith("HPE_") || PROTOCOL_CODES.has(code);
}

/** Host for UX copy: hostname only (no scheme, port, path or userinfo). */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string" && /^[A-Z0-9_]{2,60}$/.test(err.code)) {
    return err.code;
  }
  return "ERROR";
}

function attempt(url: URL, method: "HEAD" | "GET", opts: HttpCheckOptions): Promise<Attempt> {
  const clock = opts.clock ?? (() => performance.now());
  const timeoutMs = opts.timeoutMs ?? HTTP_CHECK_TIMEOUT_MS;
  const isHttps = url.protocol === "https:";
  const reqOpts: RequestOptions & { rejectUnauthorized?: boolean; ca?: (string | Buffer)[]; servername?: string } = {
    method,
    hostname: hostOf(url),
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    agent: false, // fresh connection: a check measures reachability, not a pooled socket
  };
  if (url.username || url.password) {
    reqOpts.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  }
  if (isHttps) {
    reqOpts.rejectUnauthorized = opts.tlsVerify;
    if (opts.tlsVerify && opts.ca) reqOpts.ca = [...rootCertificates, opts.ca];
  }

  return new Promise<Attempt>((resolveAttempt) => {
    let settled = false;
    let timedOut = false;
    let req: ClientRequest | undefined;
    const started = clock();
    const finish = (a: Attempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolveAttempt(a);
    };
    const onAbort = () => {
      req?.destroy();
      finish({ ok: false, code: "ABORT_ERR", timedOut: false, aborted: true });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      req?.destroy();
      finish({ ok: false, code: "ETIMEDOUT", timedOut: true, aborted: false });
    }, timeoutMs);
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      req = (isHttps ? httpsRequest : httpRequest)(reqOpts, (res: IncomingMessage) => {
        const latencyMs = Math.max(0, Math.round(clock() - started));
        const status = res.statusCode ?? 0;
        // Discard the body: we only need the status line.
        res.on("error", () => {});
        res.destroy();
        finish({ ok: true, status, latencyMs });
      });
    } catch (err) {
      // Synchronous throw, e.g. an invalid header value from userinfo.
      finish({ ok: false, code: errorCode(err), timedOut: false, aborted: false });
      return;
    }
    req.on("error", (err) => {
      finish({ ok: false, code: errorCode(err), timedOut, aborted: false });
    });
    req.end();
  });
}

function failureOutcome(a: Extract<Attempt, { ok: false }>, host: string, secrets: readonly string[]): CheckOutcome {
  let reason: StatusReason;
  let detail: string | undefined;
  if (a.aborted) return checkFailed("http", "cancelled", host);
  if (a.timedOut) reason = "timeout";
  else if (a.code === "ECONNREFUSED") reason = "refused";
  else if (DNS_CODES.has(a.code)) reason = "dns";
  else if (isTlsErrorCode(a.code)) {
    reason = "tls";
    detail = a.code;
  } else {
    reason = "unreachable";
    detail = a.code;
  }
  const out: CheckOutcome = { state: "down", kind: "http", reason, host };
  if (detail) out.detail = redact(detail, secrets);
  return out;
}

/** Run one siteMonitor check. Never throws. */
export async function checkHttp(rawUrl: string, opts: HttpCheckOptions): Promise<CheckOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return checkFailed("http", "invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return checkFailed("http", "invalid_url");
  const host = hostOf(url);
  const secrets = opts.secrets ?? [];

  let result = await attempt(url, "HEAD", opts);
  const retry = result.ok ? result.status > MAX_UP_STATUS : !result.aborted && !result.timedOut && isProtocolError(result.code);
  if (retry && !opts.signal?.aborted) {
    const second = await attempt(url, "GET", opts);
    // A failed GET after a HEAD that got a status: report the GET failure
    // unless it is a protocol error, in which case the HEAD status is the
    // more useful answer.
    if (second.ok || !result.ok || !isProtocolError(second.code)) result = second;
  }

  if (!result.ok) return failureOutcome(result, host, secrets);
  const up = result.status >= 100 && result.status <= MAX_UP_STATUS;
  const out: CheckOutcome = { state: up ? "up" : "down", kind: "http", httpStatus: result.status, latencyMs: result.latencyMs, host };
  if (!up) out.reason = "http";
  return out;
}
