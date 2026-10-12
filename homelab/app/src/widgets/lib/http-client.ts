// Shared outbound HTTP client for widget plugins. Design §4.5 and §7.4.
//
// Policy (every rule here is a security property, keep them together):
// - only the configured base URL: paths are joined below cfg.url, absolute or
//   protocol-relative paths and dot segments are refused;
// - redirects are never followed (a 3xx is bad_response);
// - credential headers (cfg.headers and per-request headers) are sent only to
//   the configured origin, which is the only origin this client ever talks to;
// - TLS verification follows the policy (default off, owner decision Q3); when
//   on, the system CAs plus the optional /config/ca.pem are trusted;
// - per-request timeout; response bodies are capped (10 MB, after decompression);
// - errors are thrown as WidgetError with the central mapping and redacted text.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Transform } from "node:stream";
import type { Logger, NormalisedWidget } from "../../types.ts";
import { redact } from "../../redact.ts";
import { WidgetError } from "../types.ts";
import type { HttpClient, RawResponse, ReqOpts } from "../types.ts";

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_S = 10;
const USER_AGENT = "HomelabDashboard";

/** TLS policy shared by HttpClient and non-HTTP clients (e.g. TrueNAS WebSocket). */
export interface TlsPolicy {
  /** false = accept any certificate (Homepage parity). */
  tlsVerify: boolean;
  /** Extra trusted CA bundle (PEM text), used only when tlsVerify is true. */
  ca?: string;
}

export interface HttpClientOptions extends TlsPolicy {
  /** The widget's configured url (cfg.url). http(s) only, no userinfo. */
  baseUrl: string;
  /** Per-request timeout in seconds. Default 10. */
  timeoutS?: number;
  /** Extra headers from the widget block (cfg.headers). Sent only to baseUrl's origin. */
  headers?: Record<string, string>;
  /** Cancels every in-flight request (e.g. the scheduler's job signal). */
  signal?: AbortSignal;
  /** Resolved secret values, redacted from every message and log line. */
  secrets?: readonly string[];
  log?: Logger;
  /** Tests only. Default MAX_BODY_BYTES. */
  maxBodyBytes?: number;
}

/** Options for tls.connect / https.request / ws, from the policy. */
export function tlsOptions(policy: TlsPolicy): { rejectUnauthorized: boolean; ca?: string[] } {
  if (!policy.tlsVerify) return { rejectUnauthorized: false };
  if (policy.ca) return { rejectUnauthorized: true, ca: [...tls.rootCertificates, policy.ca] };
  return { rejectUnauthorized: true };
}

/**
 * Reads `<configDir>/ca.pem` if present. Returns undefined when absent;
 * throws a WidgetError("config") when the file exists but holds no certificate.
 * Call once per config load and pass the result to every client.
 */
export async function loadCaPem(configDir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(configDir, "ca.pem"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WidgetError("config", `Can't read ca.pem (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!text.includes("-----BEGIN CERTIFICATE-----")) {
    throw new WidgetError("config", "ca.pem doesn't contain a PEM certificate");
  }
  return text;
}

const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NONAME",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT", // TCP connect timeout from the OS, not ours
  "EADDRNOTAVAIL",
  "ENETDOWN",
  "EHOSTDOWN",
]);

const TLS_CODE_RE =
  /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|ERR_OSSL_|HOSTNAME_MISMATCH|INVALID_CA)/;

/**
 * Central mapping of a low-level network error to a WidgetError (design §4.5).
 * Exported for non-HTTP clients (WebSocket) so every plugin maps alike.
 */
export function mapNetworkError(err: unknown, secrets: readonly string[] = []): WidgetError {
  if (err instanceof WidgetError) return err;
  const e = err as NodeJS.ErrnoException | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  if (e?.name === "AbortError" || code === "ABORT_ERR") return new WidgetError("timeout", "Request cancelled");
  if (TLS_CODE_RE.test(code)) return new WidgetError("unreachable", `TLS error: ${code}`, undefined, code);
  if (UNREACHABLE_CODES.has(code)) return new WidgetError("unreachable", `Connection failed: ${code}`, undefined, code);
  if (code.startsWith("HPE_")) return new WidgetError("bad_response", `Malformed HTTP response (${code})`);
  if (code === "ERR_INVALID_HTTP_TOKEN" || code === "ERR_INVALID_CHAR" || code === "ERR_HTTP_INVALID_HEADER_VALUE") {
    return new WidgetError("config", "A configured header name or value is invalid");
  }
  const msg = e?.message ? redact(String(e.message), secrets).slice(0, 200) : "unknown error";
  return new WidgetError("unreachable", `Request failed: ${code || msg}`, undefined, code || undefined);
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function parseBaseUrl(baseUrl: string): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
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
  return u;
}

/** Joins a plugin path below the base URL's path. Refuses anything that could leave it. */
export function joinUrl(base: URL, reqPath: string, query?: ReqOpts["query"]): URL {
  if (typeof reqPath !== "string") throw new WidgetError("config", "Invalid request path");
  if (SCHEME_RE.test(reqPath) || reqPath.startsWith("//") || reqPath.includes("\\") || /[\u0000-\u001f\s]/.test(reqPath)) {
    throw new WidgetError("config", "Request path must be relative to the widget url");
  }
  const qIdx = reqPath.indexOf("?");
  const pathPart = qIdx >= 0 ? reqPath.slice(0, qIdx) : reqPath;
  const queryPart = qIdx >= 0 ? reqPath.slice(qIdx + 1) : "";
  const segments = pathPart.split("/");
  for (const seg of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw new WidgetError("config", "Invalid request path");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new WidgetError("config", "Request path must not contain dot segments");
    }
  }
  const u = new URL(base.href);
  const basePath = u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
  const rel = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  u.pathname = pathPart === "" ? u.pathname : basePath + rel;
  const params = new URLSearchParams(u.search);
  for (const [k, v] of new URLSearchParams(queryPart)) params.append(k, v);
  if (query) for (const [k, v] of Object.entries(query)) params.set(k, String(v));
  u.search = params.toString();
  if (u.origin !== base.origin) throw new WidgetError("config", "Request path must be relative to the widget url");
  return u;
}

function validateHeaders(h: unknown, what: string): Record<string, string> {
  if (h === undefined || h === null) return {};
  if (typeof h !== "object" || Array.isArray(h)) throw new WidgetError("config", `${what} must be a map of strings`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw new WidgetError("config", `${what}: invalid header name`);
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new WidgetError("config", `${what}: header values must be strings`);
    }
    const s = String(v);
    if (/[\r\n\u0000]/.test(s)) throw new WidgetError("config", `${what}: invalid header value`);
    out[k.toLowerCase()] = s;
  }
  return out;
}

function flattenHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function decoderFor(encoding: string | undefined): Transform | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    case "":
    case "identity":
      return null;
    default:
      throw new WidgetError("bad_response", `Unsupported content encoding`);
  }
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const base = parseBaseUrl(opts.baseUrl);
  const timeoutMs = Math.max(1, (opts.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000);
  const maxBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const secrets = opts.secrets ?? [];
  const cfgHeaders = validateHeaders(opts.headers, "headers");
  const tlsOpts = base.protocol === "https:" ? tlsOptions(opts) : {};
  const log = opts.log;

  async function request(reqPath: string, ro: ReqOpts = {}, defaultAccept: string): Promise<RawResponse> {
    const method = ro.method ?? "GET";
    if (method !== "GET" && method !== "POST" && method !== "HEAD") throw new WidgetError("config", "Unsupported method");
    const url = joinUrl(base, reqPath, ro.query);
    // Credentials are attached only after confirming the target is the configured origin.
    if (url.origin !== base.origin) throw new WidgetError("config", "Request path must be relative to the widget url");
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: ro.accept ?? defaultAccept,
      "accept-encoding": "gzip, deflate, br",
      ...cfgHeaders,
      ...validateHeaders(ro.headers, "request headers"),
    };
    let body: Buffer | undefined;
    if (ro.body !== undefined && method !== "HEAD") {
      body = Buffer.from(JSON.stringify(ro.body), "utf8");
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }
    const what = `${method} ${url.pathname}`; // never the query: it may carry a key
    const started = Date.now();
    try {
      const res = await send(url, method, headers, body);
      log?.debug(redact(`${what} -> ${res.status} (${Date.now() - started} ms, ${res.body.length} B)`, secrets), {
        host: url.host,
      });
      if (res.status === 401 || res.status === 403) {
        throw new WidgetError("auth", `${what}: HTTP ${res.status}`, res.status);
      }
      if (res.status >= 300 && res.status < 400) {
        throw new WidgetError("bad_response", `${what}: HTTP ${res.status} redirect not followed`, res.status);
      }
      const ok = (res.status >= 200 && res.status < 300) || (ro.okStatuses ?? []).includes(res.status);
      if (!ok) throw new WidgetError("bad_response", `${what}: HTTP ${res.status}`, res.status);
      return res;
    } catch (err) {
      const we = mapNetworkError(err, secrets);
      we.message = redact(we.message, secrets);
      if (we.kind !== "auth" && we.kind !== "bad_response") {
        log?.debug(redact(`${what} failed: ${we.kind} ${we.message}`, secrets), { host: url.host });
      }
      throw we;
    }
  }

  function send(url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new WidgetError("timeout", "Request cancelled"));
        return;
      }
      const mod = url.protocol === "https:" ? https : http;
      let settled = false;
      const chunks: Buffer[] = [];
      let size = 0;
      let res: http.IncomingMessage | undefined;
      let stream: Readable | undefined;

      const finish = (err: WidgetError | Error | null, value?: RawResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) {
          stream?.destroy();
          res?.destroy();
          req.destroy();
          reject(err);
        } else resolve(value as RawResponse);
      };
      const onAbort = (): void => finish(new WidgetError("timeout", "Request cancelled"));
      const timer = setTimeout(
        () => finish(new WidgetError("timeout", `Timed out after ${timeoutMs / 1000} s`)),
        timeoutMs,
      );
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const req = mod.request(url, {
        method,
        headers,
        agent: false, // no pooling: fresh TLS options per client, nothing shared between origins
        ...tlsOpts,
      });
      req.on("error", (err) => finish(err));
      req.on("response", (r) => {
        res = r;
        const status = r.statusCode ?? 0;
        const hdrs = flattenHeaders(r.headers);
        const declared = Number(hdrs["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          finish(new WidgetError("bad_response", `Response larger than ${maxBytes} bytes`, status));
          return;
        }
        if (method === "HEAD" || (status >= 300 && status < 400)) {
          // Don't read redirect bodies; the status is all we need.
          finish(null, { status, headers: hdrs, body: Buffer.alloc(0) });
          r.resume();
          return;
        }
        let body: Readable;
        try {
          const dec = decoderFor(hdrs["content-encoding"]);
          body = dec ? r.pipe(dec) : r;
          if (dec) r.on("error", (err) => finish(err));
        } catch (err) {
          finish(err as Error);
          return;
        }
        stream = body;
        body.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            finish(new WidgetError("bad_response", `Response larger than ${maxBytes} bytes`, status));
            return;
          }
          chunks.push(c);
        });
        body.on("error", (err: NodeJS.ErrnoException) => {
          // zlib errors mean a corrupt body, not a network fault.
          if (typeof err.code === "string" && err.code.startsWith("Z_")) {
            finish(new WidgetError("bad_response", "Corrupt compressed response", status));
          } else finish(err);
        });
        body.on("end", () => finish(null, { status, headers: hdrs, body: Buffer.concat(chunks, size) }));
        r.on("aborted", () => finish(Object.assign(new Error("aborted"), { code: "ECONNRESET" })));
      });
      req.end(body);
    });
  }

  return {
    async raw(reqPath, ro) {
      return request(reqPath, ro, ro?.accept ?? "*/*");
    },
    async text(reqPath, ro) {
      const res = await request(reqPath, ro, "text/plain, */*");
      return res.body.toString("utf8");
    },
    async json<T = unknown>(reqPath: string, ro?: ReqOpts): Promise<T> {
      const res = await request(reqPath, ro, "application/json");
      const text = res.body.toString("utf8").replace(/^﻿/, "");
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new WidgetError("bad_response", `${ro?.method ?? "GET"} ${reqPath.split("?")[0]}: response isn't JSON`, res.status);
      }
    },
  };
}

/** Everything the scheduler has besides the NormalisedWidget. */
export interface WidgetHttpEnv {
  /** From loadCaPem(configDir). */
  ca?: string;
  signal?: AbortSignal;
  secrets?: readonly string[];
  log?: Logger;
}

/**
 * Convenience for the scheduler (WS2): a client bound to a normalised widget's
 * url, TLS policy, headers and timeout. Throws WidgetError("config") when the
 * url is missing or invalid.
 */
export function createWidgetHttpClient(w: NormalisedWidget, env: WidgetHttpEnv = {}): HttpClient {
  const url = w.cfg.url;
  if (typeof url !== "string" || url === "") throw new WidgetError("config", "needs `url:`");
  return createHttpClient({
    baseUrl: url,
    tlsVerify: w.tlsVerify,
    ca: env.ca,
    timeoutS: w.timeoutS,
    headers: w.cfg.headers as Record<string, string> | undefined,
    signal: env.signal,
    secrets: env.secrets,
    log: env.log,
  });
}
