// Response helpers. Every response goes through send(), which adds the
// security headers from design §4.4.
import type { ServerResponse } from "node:http";

export const CSP =
  "default-src 'self'; img-src 'self' data: https: http:; style-src 'self' 'unsafe-inline'; " +
  "frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/** For icon responses (SVG may contain script; never let it run). */
export const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'";

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
