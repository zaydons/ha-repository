// Response helpers. Every response goes through send(), which adds the
// security headers from design §4.4.
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

const CSP_COMMON =
  "img-src 'self' data: https: http:; style-src 'self'; object-src 'none'; worker-src 'none'; " +
  "frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/** Default CSP on every response. index.html overrides it with pageCsp(). */
export const CSP = `default-src 'self'; ${CSP_COMMON}`;

/**
 * CSP for index.html. Scripts need the per-request nonce, so nothing else on
 * the HA origin (/local/, other apps' ingress paths) can run here. Modules
 * imported statically from the nonced root module inherit its nonce.
 */
export function pageCsp(nonce: string): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(nonce)) throw new Error("invalid CSP nonce");
  return `default-src 'self'; script-src 'nonce-${nonce}'; ${CSP_COMMON}`;
}

/** 128 random bits, base64. A new one for every index.html response. */
export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * For icon responses (SVG may contain script; never let it run). `sandbox`
 * gives an SVG opened top-level an opaque origin instead of HA's.
 */
export const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": CSP,
};

export type Headers = Record<string, string>;

export function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string, headers: Headers = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": String(buf.length),
    ...headers,
  });
  res.end(buf);
}

export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Headers = {}): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", { "Cache-Control": "no-store", ...headers });
}

/** Error bodies carry only a fixed code, never request data or exception text. */
export function sendError(res: ServerResponse, status: number, code: string, headers: Headers = {}): void {
  sendJson(res, status, { error: code }, headers);
}
