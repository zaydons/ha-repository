// JSON API handlers (design §4.4). They only delegate to the services, so
// workstreams implement ConfigService / StateService and leave this file alone.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigService, Logger, StateService, StateSnapshot } from "../types.ts";
import { sendError, sendJson } from "./respond.ts";

export const MAX_REFRESH_BODY_BYTES = 1024;

export interface ApiDeps {
  config: ConfigService;
  state: StateService;
  log: Logger;
}

export interface ApiHandlers {
  config(req: IncomingMessage, res: ServerResponse): void;
  state(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void;
  refresh(req: IncomingMessage, res: ServerResponse): Promise<void>;
  health(req: IncomingMessage, res: ServerResponse): void;
}

/** True when the Content-Type media type is application/json (parameters ignored). */
export function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Read and discard a small body; false if it exceeds the limit. */
function drainBody(req: IncomingMessage, limit: number): Promise<boolean> {
  return new Promise((resolveBody) => {
    let size = 0;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolveBody(ok);
    };
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > limit) {
      finish(false);
      return;
    }
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish(false);
        req.pause();
      }
    });
    req.on("end", () => finish(true));
    req.on("error", () => finish(false));
  });
}

export function createApiHandlers(deps: ApiDeps): ApiHandlers {
  return {
    config(_req, res) {
      sendJson(res, 200, deps.config.getPublic());
    },

    state(_req, res, query) {
      const rev = query.get("rev");
      if (rev !== null && !/^\d{1,15}$/.test(rev)) {
        sendError(res, 400, "bad_rev");
        return;
      }
      deps.state.noteViewer();
      const snapshot: StateSnapshot = { ...deps.state.snapshot(), rev: deps.config.getPublic().rev };
      sendJson(res, 200, snapshot);
    },

    async refresh(req, res) {
      if (!isJsonContentType(req.headers["content-type"])) {
        sendError(res, 415, "content_type_must_be_json");
        return;
      }
      if (!(await drainBody(req, MAX_REFRESH_BODY_BYTES))) {
        sendError(res, 413, "body_too_large", { Connection: "close" });
        return;
      }
      const result = deps.state.requestRefresh();
      if (result.accepted) {
        sendJson(res, 202, { accepted: true });
      } else {
        const retryAfterS = Math.max(1, Math.ceil(result.retryAfterS));
        sendJson(res, 429, { retryAfterS }, { "Retry-After": String(retryAfterS) });
      }
    },

    health(_req, res) {
      sendJson(res, 200, { ok: true });
    },
  };
}
