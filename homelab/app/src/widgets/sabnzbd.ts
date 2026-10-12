// SABnzbd. Fields and labels match Homepage's sabnzbd widget.
// Vendor API: https://sabnzbd.org/wiki/configuration/4.5/api (mode=queue).
//
// SABnzbd only accepts the API key as the `apikey` query parameter, so the key
// is passed through ReqOpts.query (never baked into the path). HttpClient logs
// and error messages carry only the path, and redact() also scrubs `apikey=`
// and every resolved secret value, so the key can't reach a log or an error.
import { WidgetError } from "./types.ts";
import type { WidgetConfig, WidgetPlugin, WidgetValue } from "./types.ts";
import { expectRecord, isRecord, parseSize, pickFields, toNumber, toText } from "./lib/format.ts";

function keyOf(cfg: WidgetConfig): string | null {
  return typeof cfg.key === "string" && cfg.key.trim() !== "" ? cfg.key.trim() : null;
}

export const sabnzbd: WidgetPlugin = {
  type: "sabnzbd",
  fields: [
    { key: "rate", label: "Rate", format: "byterate" },
    { key: "queue", label: "Queue", format: "number" },
    { key: "timeleft", label: "Time Left", format: "text" },
  ],
  defaultFields: ["rate", "queue", "timeleft"],
  configKeys: { required: ["url", "key"], optional: [], secret: ["key"] },
  validate(cfg) {
    return keyOf(cfg) ? null : "needs `key:`";
  },
  async fetch(ctx) {
    const key = keyOf(ctx.cfg);
    if (!key) throw new WidgetError("config", "needs `key:`");
    // Read as text: depending on version, a key error may come back as plain
    // "error: API Key Incorrect" instead of JSON.
    const text = await ctx.http.text("/api", {
      query: { mode: "queue", output: "json", apikey: key },
      accept: "application/json, text/plain;q=0.5",
    });
    if (/^\s*error:\s*api ?key/i.test(text)) throw new WidgetError("auth", "SABnzbd rejected the API key");
    let body: unknown;
    try {
      body = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      throw new WidgetError("bad_response", "api?mode=queue: response isn't JSON");
    }
    const root = expectRecord(body, "api?mode=queue");
    // With output=json a wrong or missing key is HTTP 200 + {"status": false, "error": "API Key Incorrect"}.
    if (root.status === false || (typeof root.error === "string" && !isRecord(root.queue))) {
      const msg = typeof root.error === "string" ? root.error : "";
      if (/api ?key/i.test(msg)) throw new WidgetError("auth", "SABnzbd rejected the API key");
      throw new WidgetError("bad_response", "SABnzbd answered with an error");
    }
    const queue = expectRecord(root.queue, "api?mode=queue: queue");

    // speed is a human size per second ("1.2 M" = 1.2 MiB/s); kbpersec is the same in KiB/s.
    let rate = parseSize(queue.speed);
    if (rate === null) {
      const kb = toNumber(queue.kbpersec);
      rate = kb === null ? null : kb * 1024;
    }
    const slots = toNumber(queue.noofslots ?? queue.noofslots_total);
    const values: Record<string, WidgetValue> = {
      rate: rate === null ? null : Math.max(0, Math.round(rate)),
      queue: slots === null ? null : Math.max(0, Math.trunc(slots)),
      timeleft: toText(queue.timeleft, 32),
    };
    return pickFields(values, ctx.fields);
  },
};
