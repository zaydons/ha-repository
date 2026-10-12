// Shared client for the *arr family (Sonarr, Radarr, Lidarr, Prowlarr).
// Design §4.6: the key is sent in the X-Api-Key header (never the URL).
// Vendor API: https://sonarr.tv/docs/api/ , https://radarr.video/docs/api/ ,
// https://lidarr.audio/docs/api/ , https://prowlarr.com/docs/api/
import { WidgetError } from "../types.ts";
import type { WidgetConfig, WidgetContext } from "../types.ts";
import { expectArray, expectRecord, isRecord, toNumber } from "./format.ts";

export type ArrApiVersion = "v1" | "v3";

export interface ArrClient {
  /** GET /api/<v>/<path> as JSON. */
  get(path: string, query?: Record<string, string | number | boolean>): Promise<unknown>;
  /**
   * Paged or status endpoint count: requests pageSize=1 and reads
   * `totalRecords` (paged lists) or `totalCount` (queue/status).
   * A missing count is null (partial response), not an error.
   */
  count(path: string): Promise<number | null>;
  /** Endpoint that returns a JSON list; anything else is bad_response. */
  list(path: string): Promise<unknown[]>;
}

/** Shared validate() for the arr plugins. */
export function validateArr(cfg: WidgetConfig): string | null {
  if (typeof cfg.key !== "string" || cfg.key.trim() === "") return "needs `key:`";
  return null;
}

export function arrClient(ctx: WidgetContext, apiVersion: ArrApiVersion): ArrClient {
  const key = ctx.cfg.key;
  if (typeof key !== "string" || key.trim() === "") throw new WidgetError("config", "needs `key:`");
  const headers = { "X-Api-Key": key.trim() };
  const full = (p: string): string => `/api/${apiVersion}/${p.replace(/^\/+/, "")}`;

  const get = (p: string, query?: Record<string, string | number | boolean>): Promise<unknown> =>
    ctx.http.json(full(p), { headers, query });

  return {
    get,
    async count(p) {
      const body = expectRecord(await get(p, { pageSize: 1 }), p);
      const n = toNumber(body.totalRecords ?? body.totalCount);
      return n === null ? null : Math.max(0, Math.trunc(n));
    },
    async list(p) {
      return expectArray(await get(p), p);
    },
  };
}

/** Counts list items with `pred`, ignoring non-object entries. */
export function countItems(list: readonly unknown[], pred: (o: Record<string, unknown>) => boolean = () => true): number {
  let n = 0;
  for (const it of list) if (isRecord(it) && pred(it)) n++;
  return n;
}
