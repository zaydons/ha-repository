// Stub plugin registry for config-engine tests: the 10 v1 widget types with
// the metadata from design §4.6 (fields, defaults, config keys). fetch() is
// never called by the config engine. Replaced by the real registry once
// WS3/WS4 land; the shapes follow the frozen WidgetPlugin contract.
import type { FieldFormat } from "../../src/types.ts";
import type { WidgetConfig, WidgetPlugin } from "../../src/widgets/types.ts";

function plugin(
  type: string,
  fields: [string, string, FieldFormat?][],
  defaults: string[] | "all",
  keys: { required?: string[]; optional?: string[]; secret?: string[] },
  extra: Partial<WidgetPlugin> = {},
): WidgetPlugin {
  const defs = fields.map(([key, label, format]) => ({ key, label, format: format ?? "number" }));
  return {
    type,
    fields: defs,
    defaultFields: defaults === "all" ? defs.map((d) => d.key).slice(0, 4) : defaults,
    configKeys: { required: keys.required ?? ["url", "key"], optional: keys.optional ?? [], secret: keys.secret ?? ["key"] },
    async fetch() {
      throw new Error("stub plugin: fetch is not used by the config engine");
    },
    ...extra,
  };
}

export const stubPlugins: WidgetPlugin[] = [
  plugin("sonarr", [["wanted", "Wanted"], ["queued", "Queued"], ["series", "Series"]], "all", { optional: ["enableQueue"] }),
  plugin("radarr", [["wanted", "Wanted"], ["missing", "Missing"], ["queued", "Queued"], ["movies", "Movies"]], "all", { optional: ["enableQueue"] }),
  plugin("lidarr", [["wanted", "Wanted"], ["queued", "Queued"], ["artists", "Artists"]], "all", {}),
  plugin("prowlarr", [["numberOfGrabs", "Grabs"], ["numberOfQueries", "Queries"], ["numberOfFailGrabs", "Fail Grabs"], ["numberOfFailQueries", "Fail Queries"]], "all", {}),
  plugin("sabnzbd", [["rate", "Rate", "byterate"], ["queue", "Queue"], ["timeleft", "Time Left", "text"]], "all", {}),
  plugin("plex", [["streams", "Active Streams"], ["albums", "Albums"], ["movies", "Movies"], ["tv", "TV Shows"]], "all", {}, { intervalS: 60 }),
  plugin(
    "jellyfin",
    [["movies", "Movies"], ["series", "Series"], ["episodes", "Episodes"], ["songs", "Songs"], ["albums", "Albums"], ["playing", "Playing"]],
    ["movies", "series", "episodes", "playing"],
    { optional: ["version", "enableBlocks", "enableNowPlaying", "enableUser", "enableMediaControl", "showEpisodeNumber", "expandOneStreamToTwoRows"] },
    { showsNowPlaying: (cfg: WidgetConfig) => cfg.enableNowPlaying !== false },
  ),
  plugin("audiobookshelf", [["podcasts", "Podcasts"], ["podcastsDuration", "Duration", "duration"], ["books", "Books"], ["booksDuration", "Duration", "duration"]], "all", {}),
  plugin("immich", [["users", "Users"], ["photos", "Photos"], ["videos", "Videos"], ["storage", "Storage", "bytes"]], "all", { optional: ["version"] }),
  plugin(
    "truenas",
    [["load", "System Load"], ["uptime", "Uptime", "duration"], ["alerts", "Alerts"]],
    "all",
    { required: ["url"], optional: ["key", "username", "password", "version", "enablePools", "nasType"], secret: ["key", "password"] },
    {
      validate: (cfg: WidgetConfig) =>
        cfg.key || (cfg.username && cfg.password) ? null : "The truenas widget needs `key:` or `username:` and `password:`.",
    },
  ),
];

/** Records resolve() calls; mimics the WS6 IconService.resolve contract. */
export function stubIcons() {
  const calls: { icon: string | undefined; name: string }[] = [];
  return {
    calls,
    resolve(icon: string | undefined, name: string) {
      calls.push({ icon, name });
      const letter = [...name.trim()][0]?.toUpperCase();
      if (icon && /^(mdi|si)-([a-z0-9-]+)$/.test(icon)) {
        const [, set, n] = /^(mdi|si)-([a-z0-9-]+)$/.exec(icon)!;
        return { kind: "proxied" as const, src: `icons/${set}/${n}.svg` };
      }
      if (icon && /^[a-z0-9-]+\.(png|svg|webp)$/.test(icon)) return { kind: "proxied" as const, src: `icons/di/${icon}` };
      if (icon && /^https?:\/\//.test(icon)) return { kind: "url" as const, src: icon };
      return letter ? { kind: "letter" as const, letter } : undefined;
    },
  };
}
