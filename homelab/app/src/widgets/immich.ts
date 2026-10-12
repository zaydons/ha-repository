// Immich widget. Design §4.6. Credential in the `x-api-key` header.
//   version 1 (default, Homepage parity; Immich < 1.118): GET /api/server-info/statistics
//   version 2 (Immich >= 1.118):                          GET /api/server/statistics
// Response: { photos, videos, usage (bytes), usageByUser: [...] }.
// The key needs the server.statistics permission (an admin key).
import { expectRecord, pickFields, toNumber } from "./lib/format.ts";
import { checkCredential, credential, parseVersion } from "./lib/media.ts";
import { WidgetError } from "./types.ts";
import type { WidgetConfig, WidgetPlugin } from "./types.ts";

export const IMMICH_PATHS: Record<number, string> = {
  1: "/api/server-info/statistics",
  2: "/api/server/statistics",
};

function versionOf(cfg: Readonly<WidgetConfig>): number {
  const v = parseVersion(cfg.version, [1, 2], 1);
  if (v === null) throw new WidgetError("config", "`version` must be 1 or 2");
  return v;
}

export const immich: WidgetPlugin = {
  type: "immich",
  fields: [
    { key: "users", label: "Users", format: "number" },
    { key: "photos", label: "Photos", format: "number" },
    { key: "videos", label: "Videos", format: "number" },
    { key: "storage", label: "Storage", format: "bytes" },
  ],
  defaultFields: ["users", "photos", "videos", "storage"],
  configKeys: { required: ["url", "key"], optional: ["version"], secret: ["key"] },
  validate(cfg) {
    if (parseVersion(cfg.version, [1, 2], 1) === null) return "`version` must be 1 or 2";
    return checkCredential(cfg);
  },
  async fetch(ctx) {
    const version = versionOf(ctx.cfg);
    const path = IMMICH_PATHS[version] as string;
    let body: unknown;
    try {
      body = await ctx.http.json(path, { headers: { "x-api-key": credential(ctx.cfg) } });
    } catch (err) {
      if (err instanceof WidgetError && err.kind === "auth" && err.httpStatus === 403) {
        throw new WidgetError("auth", "Immich refused the key: it needs the server.statistics permission", 403);
      }
      if (err instanceof WidgetError && err.kind === "bad_response" && err.httpStatus === 404) {
        throw new WidgetError(
          "config",
          version === 1
            ? "Immich has no v1 statistics API here: set `version: 2` (Immich 1.118 or newer)"
            : "Immich has no v2 statistics API here: set `version: 1` (Immich older than 1.118)",
          404,
        );
      }
      throw err;
    }
    const stats = expectRecord(body, path);
    return pickFields(
      {
        users: Array.isArray(stats.usageByUser) ? stats.usageByUser.length : null,
        photos: toNumber(stats.photos),
        videos: toNumber(stats.videos),
        storage: toNumber(stats.usage),
      },
      ctx.fields,
    );
  },
};
