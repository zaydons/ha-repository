// Plex Media Server widget. Design §4.6.
// Vendor API (JSON via Accept: application/json; token in the X-Plex-Token header):
//   GET /status/sessions                 -> MediaContainer.size (active streams)
//   GET /library/sections                -> MediaContainer.Directory[] {key, type}
//   GET /library/sections/{key}/all      (movie, show)  \ with X-Plex-Container-Start=0 and
//   GET /library/sections/{key}/albums   (artist)       / -Size=0 -> MediaContainer.totalSize
import { expectRecord, isRecord, pickFields, toNumber, wants } from "./lib/format.ts";
import { checkCredential, credential, mapLimit, safeId } from "./lib/media.ts";
import type { WidgetContext, WidgetPlugin, WidgetValue } from "./types.ts";

/** Upper bound on library sections scanned per round (each is one request). */
const MAX_SECTIONS = 50;

type Kind = "movies" | "tv" | "albums";
const SECTION_KIND: Record<string, { kind: Kind; sub: "all" | "albums" }> = {
  movie: { kind: "movies", sub: "all" },
  show: { kind: "tv", sub: "all" },
  artist: { kind: "albums", sub: "albums" },
};

function headers(ctx: WidgetContext): Record<string, string> {
  return { "X-Plex-Token": credential(ctx.cfg) };
}

function container(body: unknown, what: string): Record<string, unknown> {
  const mc = expectRecord(body, what).MediaContainer;
  return expectRecord(mc, `${what} MediaContainer`);
}

async function streams(ctx: WidgetContext): Promise<number | null> {
  const mc = container(await ctx.http.json("/status/sessions", { headers: headers(ctx) }), "/status/sessions");
  const size = toNumber(mc.size);
  if (size !== null) return size;
  return Array.isArray(mc.Metadata) ? mc.Metadata.length : 0;
}

async function libraryCounts(ctx: WidgetContext): Promise<Record<Kind, number | null>> {
  const mc = container(await ctx.http.json("/library/sections", { headers: headers(ctx) }), "/library/sections");
  const dirs = Array.isArray(mc.Directory) ? mc.Directory : [];
  const jobs: { kind: Kind; path: string }[] = [];
  for (const d of dirs) {
    if (!isRecord(d) || typeof d.type !== "string") continue;
    const spec = SECTION_KIND[d.type];
    if (!spec || !wants(ctx.fields, spec.kind)) continue;
    const key = safeId(d.key);
    if (key === null) {
      ctx.log.debug("Plex: skipped a library section with an unexpected key");
      continue;
    }
    jobs.push({ kind: spec.kind, path: `/library/sections/${key}/${spec.sub}` });
  }
  if (jobs.length > MAX_SECTIONS) ctx.log.debug(`Plex: counting only the first ${MAX_SECTIONS} sections`);
  const counts: Record<Kind, number | null> = { movies: 0, tv: 0, albums: 0 };
  const sizes = await mapLimit(jobs.slice(0, MAX_SECTIONS), 4, async (job) => {
    const body = await ctx.http.json(job.path, {
      headers: headers(ctx),
      query: { "X-Plex-Container-Start": 0, "X-Plex-Container-Size": 0 },
    });
    const c = container(body, "/library/sections/{key}");
    return toNumber(c.totalSize) ?? toNumber(c.size);
  });
  jobs.slice(0, MAX_SECTIONS).forEach((job, i) => {
    const n = sizes[i] ?? null;
    const prev = counts[job.kind];
    // One section that doesn't report a size makes the total unknown.
    counts[job.kind] = n === null || prev === null ? null : prev + n;
  });
  return counts;
}

export const plex: WidgetPlugin = {
  type: "plex",
  fields: [
    { key: "streams", label: "Active Streams", format: "number" },
    { key: "albums", label: "Albums", format: "number" },
    { key: "movies", label: "Movies", format: "number" },
    { key: "tv", label: "TV Shows", format: "number" },
  ],
  defaultFields: ["streams", "albums", "movies", "tv"],
  configKeys: { required: ["url", "key"], optional: [], secret: ["key"] },
  // Section scans are heavier than the other widgets (design §4.6, R10).
  intervalS: 60,
  validate: (cfg) => checkCredential(cfg),
  async fetch(ctx) {
    const [s, libs] = await Promise.all([
      wants(ctx.fields, "streams") ? streams(ctx) : Promise.resolve(null),
      wants(ctx.fields, "movies", "tv", "albums") ? libraryCounts(ctx) : Promise.resolve(null),
    ]);
    const values: Record<string, WidgetValue> = {
      streams: s,
      movies: libs?.movies ?? null,
      tv: libs?.tv ?? null,
      albums: libs?.albums ?? null,
    };
    return pickFields(values, ctx.fields);
  },
};
