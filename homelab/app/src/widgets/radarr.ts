// Radarr (API v3). Fields and labels match Homepage's radarr widget.
import type { WidgetPlugin, WidgetValue } from "./types.ts";
import { arrClient, countItems, validateArr } from "./lib/arr.ts";
import { pickFields, wants } from "./lib/format.ts";

export const radarr: WidgetPlugin = {
  type: "radarr",
  fields: [
    { key: "wanted", label: "Wanted", format: "number" },
    { key: "missing", label: "Missing", format: "number" },
    { key: "queued", label: "Queued", format: "number" },
    { key: "movies", label: "Movies", format: "number" },
  ],
  defaultFields: ["wanted", "missing", "queued", "movies"],
  // enableQueue (Homepage's queue list) is accepted and ignored in v1.
  configKeys: { required: ["url", "key"], optional: ["enableQueue"], secret: ["key"] },
  timeoutS: 20, // /movie can be several MB for large libraries
  validate: validateArr,
  async fetch(ctx) {
    const arr = arrClient(ctx, "v3");
    const f = ctx.fields;
    const [movies, queued] = await Promise.all([
      wants(f, "wanted", "missing", "movies") ? arr.list("movie") : null,
      wants(f, "queued") ? arr.count("queue/status") : null,
    ]);
    const values: Record<string, WidgetValue> = { queued };
    if (movies) {
      const missing = (m: Record<string, unknown>): boolean => m.monitored === true && m.hasFile !== true;
      values.wanted = countItems(movies, (m) => missing(m) && m.isAvailable === true);
      values.missing = countItems(movies, missing);
      values.movies = countItems(movies, (m) => m.hasFile === true);
    }
    return pickFields(values, f);
  },
};
