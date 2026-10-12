// The route table (design §4.4). EVERY route is registered here by WS0; other
// workstreams implement the services behind them and should not need to edit
// this file. Everything not listed is 404.
//
//   GET  /                       index.html
//   GET  /static/<path>          web/<path>
//   GET  /vendor/{preact,hooks,htm}.mjs
//   GET  /icons/<set>/<name>     IconService (set: mdi|si|di|sh|local)
//   GET  /api/config             PublicConfig
//   GET  /api/state?rev=<n>      StateSnapshot
//   POST /api/refresh            202 | 429 (Content-Type: application/json required)
//   GET  /api/health             {"ok":true}
//
// HEAD is accepted wherever GET is. Paths are relative to the ingress root
// (Supervisor strips /api/hassio_ingress/<token> before proxying).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigService, IconService, IconSet, Logger, StateService } from "../types.ts";
import { ICON_SETS } from "../types.ts";
import { createApiHandlers } from "./api.ts";
import { ICON_CSP, newNonce, pageCsp, send, sendError } from "./respond.ts";
import { injectNonce } from "./static.ts";
import type { StaticFiles } from "./static.ts";

export interface RouterDeps {
  config: ConfigService;
  state: StateService;
  icons: IconService;
  files: StaticFiles;
  log: Logger;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

const MAX_URL_LENGTH = 2048;
/** Basic icon name check; IconService validates further per set. */
export const ICON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Method = "GET" | "POST";

interface Route {
  method: Method;
  run: (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray, query: URLSearchParams) => void | Promise<void>;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function createRouter(deps: RouterDeps): RequestHandler {
  const api = createApiHandlers(deps);
  const log = deps.log;

  const routes: Array<[RegExp, Route]> = [
    [
      /^\/$/,
      {
        method: "GET",
        run: async (_req, res) => {
          const f = await deps.files.index();
          if (!f) return sendError(res, 404, "not_found");
          const nonce = newNonce();
          send(res, 200, injectNonce(f.body, nonce), f.contentType, {
            "Cache-Control": "no-cache",
            "Content-Security-Policy": pageCsp(nonce),
          });
        },
      },
    ],
    [
      /^\/static\/(.+)$/,
      {
        method: "GET",
        run: async (_req, res, m) => {
          const rel = safeDecode(m[1]!);
          const f = rel === null ? null : await deps.files.file(rel);
          if (!f) return sendError(res, 404, "not_found");
          send(res, 200, f.body, f.contentType, { "Cache-Control": "public, max-age=300" });
        },
      },
    ],
    [
      /^\/vendor\/([a-z]+\.mjs)$/,
      {
        method: "GET",
        run: (_req, res, m) => {
          const f = deps.files.vendor(m[1]!);
          if (!f) return sendError(res, 404, "not_found");
          send(res, 200, f.body, f.contentType, { "Cache-Control": "public, max-age=300" });
        },
      },
    ],
    [
      /^\/icons\/([a-z]+)\/([^/]+)$/,
      {
        method: "GET",
        run: async (_req, res, m, query) => {
          const set = m[1] as IconSet;
          const name = safeDecode(m[2]!);
          if (!ICON_SETS.includes(set) || name === null || !ICON_NAME_RE.test(name)) {
            return sendError(res, 404, "not_found");
          }
          const icon = await deps.icons.get(set, name, query);
          if (!icon) return sendError(res, 404, "not_found");
          send(res, 200, icon.body, icon.contentType, {
            "Cache-Control": icon.cacheControl ?? "public, max-age=86400",
            "Content-Security-Policy": ICON_CSP,
          });
        },
      },
    ],
    [/^\/api\/config$/, { method: "GET", run: (req, res) => api.config(req, res) }],
    [/^\/api\/state$/, { method: "GET", run: (req, res, _m, q) => api.state(req, res, q) }],
    [/^\/api\/refresh$/, { method: "POST", run: (req, res) => api.refresh(req, res) }],
    [/^\/api\/health$/, { method: "GET", run: (req, res) => api.health(req, res) }],
  ];

  return (req, res) => {
    const started = Date.now();
    const rawUrl = req.url ?? "";
    const q = rawUrl.indexOf("?");
    const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const query = new URLSearchParams(q === -1 ? "" : rawUrl.slice(q + 1));
    res.on("finish", () => log.debug(`${req.method} ${path.slice(0, 200)} ${res.statusCode} ${Date.now() - started}ms`));

    const fail = (err: unknown) => {
      log.error(`Unhandled error for ${req.method} ${path.slice(0, 200)}`, { err: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendError(res, 500, "internal");
      else res.destroy();
    };

    try {
      if (rawUrl.length > MAX_URL_LENGTH) return sendError(res, 414, "uri_too_long");
      if (!path.startsWith("/")) return sendError(res, 400, "bad_request");

      for (const [re, route] of routes) {
        const m = re.exec(path);
        if (!m) continue;
        const method = req.method === "HEAD" ? "GET" : req.method;
        if (method !== route.method) {
          const allow = route.method === "GET" ? "GET, HEAD" : route.method;
          return sendError(res, 405, "method_not_allowed", { Allow: allow });
        }
        const out = route.run(req, res, m, query);
        if (out instanceof Promise) out.catch(fail);
        return;
      }
      sendError(res, 404, "not_found");
    } catch (err) {
      fail(err);
    }
  };
}
