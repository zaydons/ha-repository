// Sonarr (API v3). Fields and labels match Homepage's sonarr widget.
import type { WidgetPlugin, WidgetValue } from "./types.ts";
import { arrClient, countItems, validateArr } from "./lib/arr.ts";
import { pickFields, wants } from "./lib/format.ts";

export const sonarr: WidgetPlugin = {
  type: "sonarr",
  fields: [
    { key: "wanted", label: "Wanted", format: "number" },
    { key: "queued", label: "Queued", format: "number" },
    { key: "series", label: "Series", format: "number" },
  ],
  defaultFields: ["wanted", "queued", "series"],
  // enableQueue (Homepage's queue list) is accepted and ignored in v1.
  configKeys: { required: ["url", "key"], optional: ["enableQueue"], secret: ["key"] },
  timeoutS: 20, // /series is a full list
  validate: validateArr,
  async fetch(ctx) {
    const arr = arrClient(ctx, "v3");
    const f = ctx.fields;
    const [wanted, queued, series] = await Promise.all([
      wants(f, "wanted") ? arr.count("wanted/missing") : null,
      wants(f, "queued") ? arr.count("queue") : null,
      wants(f, "series") ? arr.list("series").then((l) => countItems(l)) : null,
    ]);
    const values: Record<string, WidgetValue> = { wanted, queued, series };
    return pickFields(values, f);
  },
};
