// Jellyfin widget: count blocks plus the "Now playing" list (ux.md §14, contract D1).
// Vendor API (Jellyfin OpenAPI), credential in `Authorization: MediaBrowser Token="…"`.
// Paths have no /emby prefix, valid on 10.x and on 12 (which drops the legacy
// prefix and legacy token headers), so `version: 1|2` needs no branching.
//   GET /Items/Counts -> MovieCount, SeriesCount, EpisodeCount, SongCount, AlbumCount
//   GET /Sessions     -> SessionInfo[]; sessions with a NowPlayingItem are "playing"
//
// Homepage parity for defaults: enableBlocks false, enableNowPlaying true,
// enableUser false, showEpisodeNumber false.
import { expectArray, expectRecord, isRecord, pickFields, toNumber, wants } from "./lib/format.ts";
import { checkCredential, checkFlags, credential, flag, parseVersion, plainText } from "./lib/media.ts";
import type { NowPlayingItem, WidgetConfig, WidgetContext, WidgetPlugin, WidgetValue } from "./types.ts";

/**
 * Title for an item without a name (ux.md copy C-34). The scheduler drops
 * items with an empty title, so the plugin fills it in to keep the list
 * consistent with the "playing" count.
 */
export const UNTITLED = "Untitled";

/** Items kept in the list (UI shows 2, the screen-reader text up to 10). The count stays exact. */
export const MAX_NOW_PLAYING = 20;

const COUNT_FIELDS: Record<string, string> = {
  movies: "MovieCount",
  series: "SeriesCount",
  episodes: "EpisodeCount",
  songs: "SongCount",
  albums: "AlbumCount",
};

const FLAGS = ["enableBlocks", "enableNowPlaying", "enableUser", "enableMediaControl", "showEpisodeNumber", "expandOneStreamToTwoRows"];

function auth(cfg: Readonly<WidgetConfig>): Record<string, string> {
  return { Authorization: `MediaBrowser Token="${credential(cfg)}"` };
}

function showsNowPlaying(cfg: WidgetConfig): boolean {
  return flag(cfg.enableNowPlaying, true);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function subtitleOf(item: Record<string, unknown>, showEpisodeNumber: boolean): string | null {
  switch (item.Type) {
    case "Episode": {
      const series = plainText(item.SeriesName);
      const season = toNumber(item.ParentIndexNumber);
      const episode = toNumber(item.IndexNumber);
      const se =
        showEpisodeNumber && season !== null && episode !== null && Number.isInteger(season) && Number.isInteger(episode)
          ? `S${pad2(season)}E${pad2(episode)}`
          : null;
      return [series, se].filter((s): s is string => s !== null).join(" · ") || null;
    }
    case "Movie":
      return plainText(item.ProductionYear);
    case "Audio": {
      const artists = Array.isArray(item.Artists) ? item.Artists : [];
      const artist = plainText(item.AlbumArtist) ?? plainText(artists[0]);
      return [artist, plainText(item.Album)].filter((s): s is string => s !== null).join(" · ") || null;
    }
    default:
      return null;
  }
}

function progressOf(item: Record<string, unknown>, play: Record<string, unknown>): number | null {
  const pos = toNumber(play.PositionTicks);
  const run = toNumber(item.RunTimeTicks);
  if (pos === null || run === null || run <= 0 || pos < 0) return null;
  const pct = Math.min(100, Math.max(0, (pos / run) * 100));
  return Math.round(pct * 10) / 10;
}

interface Row {
  item: NowPlayingItem;
  sortUser: string;
  sortId: string;
}

/** Display items for sessions that are playing something, in a stable order (ux.md §14.3). */
export function nowPlayingItems(sessions: readonly unknown[], cfg: Readonly<WidgetConfig>): NowPlayingItem[] {
  const showUser = flag(cfg.enableUser, false);
  const showEp = flag(cfg.showEpisodeNumber, false);
  const rows: Row[] = [];
  for (const s of sessions) {
    if (!isRecord(s) || !isRecord(s.NowPlayingItem)) continue;
    const np = s.NowPlayingItem;
    const play = isRecord(s.PlayState) ? s.PlayState : {};
    const user = plainText(s.UserName, 100);
    const item: NowPlayingItem = { title: plainText(np.Name) ?? UNTITLED };
    const subtitle = subtitleOf(np, showEp);
    if (subtitle !== null) item.subtitle = subtitle;
    if (showUser && user !== null) item.user = user;
    const pct = progressOf(np, play);
    if (pct !== null) item.progressPct = pct;
    item.paused = play.IsPaused === true;
    rows.push({ item, sortUser: (user ?? "").toLowerCase(), sortId: typeof s.Id === "string" ? s.Id : "" });
  }
  // User name, then title, case-insensitive; never by activity time, so rows
  // don't swap between polls. The user name sorts even when it isn't shown.
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort(
    (a, b) =>
      cmp(a.sortUser, b.sortUser) ||
      cmp(a.item.title.toLowerCase(), b.item.title.toLowerCase()) ||
      cmp((a.item.subtitle ?? "").toLowerCase(), (b.item.subtitle ?? "").toLowerCase()) ||
      cmp(a.sortId, b.sortId),
  );
  return rows.slice(0, MAX_NOW_PLAYING).map((r) => r.item);
}

async function counts(ctx: WidgetContext): Promise<Record<string, number | null>> {
  const body = expectRecord(await ctx.http.json("/Items/Counts", { headers: auth(ctx.cfg) }), "/Items/Counts");
  const out: Record<string, number | null> = {};
  for (const [field, prop] of Object.entries(COUNT_FIELDS)) out[field] = toNumber(body[prop]);
  return out;
}

export const jellyfin: WidgetPlugin = {
  type: "jellyfin",
  fields: [
    { key: "movies", label: "Movies", format: "number" },
    { key: "series", label: "Series", format: "number" },
    { key: "episodes", label: "Episodes", format: "number" },
    { key: "songs", label: "Songs", format: "number" },
    { key: "albums", label: "Albums", format: "number" },
    { key: "playing", label: "Playing", format: "number" },
  ],
  defaultFields: ["movies", "series", "episodes", "playing"],
  configKeys: { required: ["url", "key"], optional: ["version", ...FLAGS], secret: ["key"] },
  validate(cfg) {
    if (parseVersion(cfg.version, [1, 2], 1) === null) return "`version` must be 1 or 2";
    return checkFlags(cfg, FLAGS) ?? checkCredential(cfg);
  },
  showsNowPlaying,
  selectFields(cfg, selected) {
    return flag(cfg.enableBlocks, false) ? [...selected] : [];
  },
  async fetch(ctx) {
    const list = showsNowPlaying(ctx.cfg);
    const needCounts = wants(ctx.fields, ...Object.keys(COUNT_FIELDS));
    const needSessions = list || wants(ctx.fields, "playing");
    const [c, sessions] = await Promise.all([
      needCounts ? counts(ctx) : Promise.resolve({} as Record<string, number | null>),
      needSessions
        ? ctx.http.json("/Sessions", { headers: auth(ctx.cfg) }).then((b) => expectArray(b, "/Sessions"))
        : Promise.resolve(null),
    ]);
    const values: Record<string, WidgetValue> = { ...c };
    if (sessions !== null) {
      values.playing = sessions.filter((s) => isRecord(s) && isRecord(s.NowPlayingItem)).length;
      if (list) ctx.setNowPlaying(nowPlayingItems(sessions, ctx.cfg));
    }
    return pickFields(values, ctx.fields);
  },
};
