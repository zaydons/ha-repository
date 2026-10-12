// Test helper: a fake upstream HTTP(S) server for widget plugin and HttpClient
// tests, plus a WidgetContext builder that uses the real HttpClient.
// (node --test also loads this file; it defines no tests.)
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpClient } from "../../src/widgets/lib/http-client.ts";
import type { HttpClientOptions } from "../../src/widgets/lib/http-client.ts";
import type { WidgetConfig, WidgetContext, WidgetPlugin, WidgetValue, NowPlayingItem } from "../../src/widgets/types.ts";
import { createLogger } from "../../src/log.ts";

export type RouteSpec =
  | {
      status?: number;
      /** Serialised as JSON. */
      json?: unknown;
      /** Raw body (wins over json). */
      body?: string | Buffer;
      headers?: Record<string, string>;
      /** Wait this long before answering (timeout tests). */
      delayMs?: number;
    }
  | ((req: http.IncomingMessage, res: http.ServerResponse) => void);

export interface SeenRequest {
  method: string;
  /** Path plus query, as received. */
  url: string;
  headers: http.IncomingHttpHeaders;
}

export interface FakeUpstream {
  /** e.g. "http://127.0.0.1:54321" */
  url: string;
  requests: SeenRequest[];
  close(): Promise<void>;
}

/**
 * Routes are keyed by "METHOD /path" (query ignored), or "/path" for any method.
 * Unknown routes answer 404.
 */
export async function startFakeUpstream(
  routes: Record<string, RouteSpec>,
  tlsOpts?: { key: string | Buffer; cert: string | Buffer },
): Promise<FakeUpstream> {
  const requests: SeenRequest[] = [];
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const p = (req.url ?? "/").split("?")[0] ?? "/";
    const spec = routes[`${req.method} ${p}`] ?? routes[p];
    if (!spec) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    if (typeof spec === "function") {
      spec(req, res);
      return;
    }
    const answer = (): void => {
      if (res.destroyed) return;
      const body =
        spec.body !== undefined ? spec.body : spec.json !== undefined ? JSON.stringify(spec.json) : "";
      res.writeHead(spec.status ?? 200, {
        "content-type": spec.json !== undefined && spec.body === undefined ? "application/json" : "text/plain",
        ...spec.headers,
      });
      res.end(body);
    };
    if (spec.delayMs) setTimeout(answer, spec.delayMs);
    else answer();
  };
  const server = tlsOpts ? https.createServer(tlsOpts, handler) : http.createServer(handler);
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${tlsOpts ? "https" : "http"}://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Reads a JSON fixture from test/fixtures/<type>/<name>.json. */
export function fixture(type: string, name: string): unknown {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", type);
  return JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8"));
}

export interface TestCtx extends WidgetContext {
  nowPlaying: NowPlayingItem[] | undefined;
}

/** A WidgetContext with the real HttpClient bound to cfg.url (TLS off unless overridden). */
export function makeCtx(
  cfg: WidgetConfig,
  fields: readonly string[],
  clientOpts: Partial<HttpClientOptions> = {},
): TestCtx {
  const ac = new AbortController();
  const ctx: TestCtx = {
    cfg,
    fields,
    http: createHttpClient({
      baseUrl: String(cfg.url),
      tlsVerify: false,
      timeoutS: 2,
      headers: cfg.headers as Record<string, string> | undefined,
      secrets: Object.values(cfg).filter((v): v is string => typeof v === "string" && v.startsWith("FAKE-")),
      ...clientOpts,
    }),
    signal: ac.signal,
    log: createLogger("test"),
    nowPlaying: undefined,
    setNowPlaying(items) {
      ctx.nowPlaying = items;
    },
  };
  return ctx;
}

/** Fields the plugin shows by default, or the given list. */
export async function runPlugin(
  plugin: WidgetPlugin,
  cfg: WidgetConfig,
  fields: readonly string[] = plugin.defaultFields,
  clientOpts: Partial<HttpClientOptions> = {},
): Promise<Record<string, WidgetValue>> {
  return plugin.fetch(makeCtx(cfg, fields, clientOpts));
}
