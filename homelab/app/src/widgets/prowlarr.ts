// Prowlarr (API v1). Fields and labels match Homepage's prowlarr widget.
import type { WidgetPlugin, WidgetValue } from "./types.ts";
import { arrClient, validateArr } from "./lib/arr.ts";
import { expectArray, expectRecord, pickFields, sumOf } from "./lib/format.ts";

/** Homepage field name -> Prowlarr indexerstats property. */
const STAT: Record<string, string> = {
  numberOfGrabs: "numberOfGrabs",
  numberOfQueries: "numberOfQueries",
  numberOfFailGrabs: "numberOfFailedGrabs",
  numberOfFailQueries: "numberOfFailedQueries",
};

export const prowlarr: WidgetPlugin = {
  type: "prowlarr",
  fields: [
    { key: "numberOfGrabs", label: "Grabs", format: "number" },
    { key: "numberOfQueries", label: "Queries", format: "number" },
    { key: "numberOfFailGrabs", label: "Fail Grabs", format: "number" },
    { key: "numberOfFailQueries", label: "Fail Queries", format: "number" },
  ],
  defaultFields: ["numberOfGrabs", "numberOfQueries", "numberOfFailGrabs", "numberOfFailQueries"],
  configKeys: { required: ["url", "key"], optional: [], secret: ["key"] },
  validate: validateArr,
  async fetch(ctx) {
    const arr = arrClient(ctx, "v1");
    const body = expectRecord(await arr.get("indexerstats"), "indexerstats");
    const indexers = expectArray(body.indexers, "indexerstats.indexers");
    const values: Record<string, WidgetValue> = {};
    for (const [field, prop] of Object.entries(STAT)) values[field] = sumOf(indexers, prop);
    return pickFields(values, ctx.fields);
  },
};
