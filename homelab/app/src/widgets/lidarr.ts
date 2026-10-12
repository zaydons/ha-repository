// Lidarr (API v1). Fields and labels match Homepage's lidarr widget.
import type { WidgetPlugin, WidgetValue } from "./types.ts";
import { arrClient, countItems, validateArr } from "./lib/arr.ts";
import { pickFields, wants } from "./lib/format.ts";

export const lidarr: WidgetPlugin = {
  type: "lidarr",
  fields: [
    { key: "wanted", label: "Wanted", format: "number" },
    { key: "queued", label: "Queued", format: "number" },
    { key: "artists", label: "Artists", format: "number" },
  ],
  defaultFields: ["wanted", "queued", "artists"],
  configKeys: { required: ["url", "key"], optional: [], secret: ["key"] },
  timeoutS: 20, // /artist is a full list
  validate: validateArr,
  async fetch(ctx) {
    const arr = arrClient(ctx, "v1");
    const f = ctx.fields;
    const [wanted, queued, artists] = await Promise.all([
      wants(f, "wanted") ? arr.count("wanted/missing") : null,
      wants(f, "queued") ? arr.count("queue/status") : null,
      wants(f, "artists") ? arr.list("artist").then((l) => countItems(l)) : null,
    ]);
    const values: Record<string, WidgetValue> = { wanted, queued, artists };
    return pickFields(values, f);
  },
};
