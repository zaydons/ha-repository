// Boot: read options, start the services and the HTTP server on :8099.
// Run as `node src/server.ts` (Node type stripping; no build step).
//
// Environment (not settable through Supervisor options):
//   HL_ALLOW_ANY_SOURCE=1   disable the source-IP guard (local testing only)
//   HL_CONFIG_DIR, HL_DATA_DIR, HL_PORT   override /config, /data, 8099 for local runs
//   HL_STUB_SCENARIO        ok|banner|fatal|welcome|empty (WS0 stubs only)
import { createServer } from "node:http";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { BootContext, ConfigService, IconService, StateService } from "./types.ts";
import { createLogger, setLogLevel } from "./log.ts";
import { readOptions, resolveConfigPathDisplay } from "./options.ts";
import { attachGuard, isAllowedSource } from "./http/guard.ts";
import { createRouter } from "./http/router.ts";
import { createStaticFiles } from "./http/static.ts";
import { createStubConfigService, createStubStateService, parseScenario } from "./http/stubs.ts";
import { createIconService } from "./iconsvc/index.ts";
import { createConfigService } from "./config/index.ts";
import { plugins } from "./widgets/index.ts";
import { createWidgetHttpClient, loadCaPem } from "./widgets/lib/http-client.ts";
import { createScheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

export const DEFAULT_PORT = 8099;
const SHUTDOWN_GRACE_MS = 5000;

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface Services {
  config: ConfigService;
  state: StateService;
  icons: IconService;
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid HL_PORT: ${value}`);
  return n;
}

/** Create the HTTP server with timeouts and the guard. Does not listen. */
export function buildHttpServer(ctx: BootContext, services: Services, allowAnySource: boolean): Server {
  const files = createStaticFiles(ctx.paths.webDir, join(APP_ROOT, "node_modules"), ctx.log.child("static"));
  const router = createRouter({ ...services, files, log: ctx.log.child("http") });
  // Second line of defence behind the connection guard: never route a request
  // from a source the guard should have dropped.
  const server = createServer((req, res) => {
    if (!allowAnySource && !isAllowedSource(req.socket.remoteAddress)) {
      req.socket.destroy();
      return;
    }
    router(req, res);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  attachGuard(server, { allowAnySource, log: ctx.log.child("guard") });
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  return server;
}

async function main(): Promise<void> {
  const env = process.env;
  const log = createLogger();
  const dataDir = env.HL_DATA_DIR || "/data";
  const options = await readOptions(join(dataDir, "options.json"), log);
  setLogLevel(options.log_level);

  const ctx: BootContext = {
    options,
    paths: {
      configDir: env.HL_CONFIG_DIR || "/config",
      dataDir,
      sampleDir: join(APP_ROOT, "sample"),
      webDir: join(APP_ROOT, "web"),
    },
    configPathDisplay: await resolveConfigPathDisplay(log.child("supervisor")),
    log,
  };
  const port = parsePort(env.HL_PORT);
  const allowAnySource = env.HL_ALLOW_ANY_SOURCE === "1";

  log.info(`Starting version ${env.HL_VERSION || "dev"} (Node ${process.version}), log level ${options.log_level}`);

  // HL_STUB_SCENARIO (UI development only) serves fixture config and state.
  const icons = createIconService(ctx);
  const config = env.HL_STUB_SCENARIO ? createStubConfigService(ctx, parseScenario(env.HL_STUB_SCENARIO)) : createConfigService(ctx, plugins, icons);
  const state = env.HL_STUB_SCENARIO
    ? createStubStateService(ctx)
    : createScheduler(ctx, config, new Store(), { createHttpClient: createWidgetHttpClient, loadCa: loadCaPem });

  await config.start();
  await state.start();

  const server = buildHttpServer(ctx, { config, state, icons }, allowAnySource);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  log.info(`Listening on 0.0.0.0:${port} (ingress)`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    force.unref();
    server.close();
    server.closeIdleConnections();
    Promise.allSettled([state.stop(), config.stop()]).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    createLogger().error("Fatal error during start-up", { err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
