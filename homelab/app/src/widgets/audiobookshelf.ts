// Audiobookshelf widget. Design §4.6. Credential as `Authorization: Bearer <key>`.
//   GET /api/libraries             -> { libraries: [{ id, mediaType: "book" | "podcast" }] }
//   GET /api/libraries/{id}/stats  -> { totalItems, totalDuration (seconds) }
// Values are summed per media type over all libraries of that type.
import { expectArray, expectRecord, isRecord, pickFields, toNumber, wants } from "./lib/format.ts";
import { checkCredential, credential, mapLimit, safeId } from "./lib/media.ts";
import type { WidgetContext, WidgetPlugin } from "./types.ts";

/** Upper bound on libraries read per round (each is one request). */
const MAX_LIBRARIES = 50;

type MediaType = "book" | "podcast";
const FIELDS_FOR: Record<MediaType, [count: string, duration: string]> = {
  book: ["books", "booksDuration"],
  podcast: ["podcasts", "podcastsDuration"],
};

function auth(ctx: WidgetContext): Record<string, string> {
  return { Authorization: `Bearer ${credential(ctx.cfg)}` };
}

export const audiobookshelf: WidgetPlugin = {
  type: "audiobookshelf",
  fields: [
    { key: "podcasts", label: "Podcasts", format: "number" },
    { key: "podcastsDuration", label: "Duration", format: "duration" },
    { key: "books", label: "Books", format: "number" },
    { key: "booksDuration", label: "Duration", format: "duration" },
  ],
  defaultFields: ["podcasts", "podcastsDuration", "books", "booksDuration"],
  configKeys: { required: ["url", "key"], optional: [], secret: ["key"] },
  validate: (cfg) => checkCredential(cfg),
  async fetch(ctx) {
    const body = await ctx.http.json("/api/libraries", { headers: auth(ctx) });
    // Current servers wrap the list; very old ones returned a bare array.
    const libs = expectArray(Array.isArray(body) ? body : expectRecord(body, "/api/libraries").libraries, "/api/libraries");

    const jobs: { type: MediaType; id: string }[] = [];
    for (const lib of libs) {
      if (!isRecord(lib) || (lib.mediaType !== "book" && lib.mediaType !== "podcast")) continue;
      if (!wants(ctx.fields, ...FIELDS_FOR[lib.mediaType])) continue;
      const id = safeId(lib.id);
      if (id === null) {
        ctx.log.debug("Audiobookshelf: skipped a library with an unexpected id");
        continue;
      }
      jobs.push({ type: lib.mediaType, id });
    }
    if (jobs.length > MAX_LIBRARIES) ctx.log.debug(`Audiobookshelf: reading only the first ${MAX_LIBRARIES} libraries`);
    const used = jobs.slice(0, MAX_LIBRARIES);
    const stats = await mapLimit(used, 4, async (job) =>
      expectRecord(await ctx.http.json(`/api/libraries/${job.id}/stats`, { headers: auth(ctx) }), "/api/libraries/{id}/stats"),
    );

    // Zero libraries of a type = 0 (as Homepage shows); a library that doesn't
    // report a number makes that total unknown (null).
    const totals: Record<string, number | null> = { books: 0, booksDuration: 0, podcasts: 0, podcastsDuration: 0 };
    used.forEach((job, i) => {
      const s = stats[i] ?? {};
      const [countKey, durKey] = FIELDS_FOR[job.type];
      const add = (k: string, v: unknown): void => {
        const n = toNumber(v);
        const prev = totals[k] ?? null;
        totals[k] = n === null || prev === null ? null : prev + n;
      };
      add(countKey, s.totalItems);
      add(durKey, s.totalDuration);
    });
    for (const k of ["booksDuration", "podcastsDuration"]) {
      const v = totals[k];
      if (typeof v === "number") totals[k] = Math.round(v);
    }
    return pickFields(totals, ctx.fields);
  },
};
