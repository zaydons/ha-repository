import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { jellyfin, nowPlayingItems, MAX_NOW_PLAYING } from "../../src/widgets/jellyfin.ts";
import { fixture, makeCtx, startFakeUpstream } from "../helpers/fake-upstream.ts";
import type { FakeUpstream } from "../helpers/fake-upstream.ts";
import { checkCommonErrors, expectWidgetError } from "../helpers/plugin-errors.ts";
import type { WidgetConfig } from "../../src/widgets/types.ts";

const KEY = "FAKE-jellyfin-key-0000";
// The owner's widget block (fixtures/owner-services.yaml), key replaced.
const owner = (url: string): WidgetConfig => ({
  type: "jellyfin",
  url,
  version: 2,
  key: KEY,
  enableBlocks: true,
  enableNowPlaying: true,
});
let up: FakeUpstream;

before(async () => {
  up = await startFakeUpstream({
    "GET /Items/Counts": { json: fixture("jellyfin", "counts") },
    "GET /Sessions": { json: fixture("jellyfin", "sessions") },
  });
});
after(() => up.close());

test("jellyfin: owner config gives counts, playing and the list from one /Sessions call", async () => {
  up.requests.length = 0;
  const cfg = owner(up.url);
  const fields = jellyfin.selectFields?.(cfg, jellyfin.defaultFields) ?? [];
  assert.deepEqual(fields, ["movies", "series", "episodes", "playing"]);
  assert.equal(jellyfin.showsNowPlaying?.(cfg), true);
  const ctx = makeCtx(cfg, fields);
  const v = await jellyfin.fetch(ctx);
  assert.deepEqual(v, { movies: 1204, series: 187, episodes: 9812, playing: 4 });
  assert.equal(up.requests.filter((r) => r.url.startsWith("/Sessions")).length, 1);
  for (const r of up.requests) {
    assert.equal(r.headers.authorization, `MediaBrowser Token="${KEY}"`);
    assert.ok(!r.url.includes(KEY));
    assert.ok(!r.url.startsWith("/emby"));
  }
  // Sorted by user then title (case-insensitive); idle session dropped; no user names (enableUser unset).
  assert.deepEqual(ctx.nowPlaying, [
    { title: "Dune: Part Two", subtitle: "2024", progressPct: 42, paused: false },
    {
      title: "<b>Track</b> & <img src=x onerror=alert(1)>",
      subtitle: "Example Artist · Example Album",
      progressPct: 0,
      paused: false,
    },
    { title: "The Example Episode", subtitle: "Sample Show", progressPct: 71, paused: true },
    { title: "Untitled", paused: false },
  ]);
});

test("jellyfin: Homepage defaults: blocks off, now playing on", async () => {
  const cfg: WidgetConfig = { type: "jellyfin", url: up.url, key: KEY };
  assert.deepEqual(jellyfin.selectFields?.(cfg, ["movies", "playing"]), []);
  assert.equal(jellyfin.showsNowPlaying?.(cfg), true);
  up.requests.length = 0;
  const ctx = makeCtx(cfg, []);
  assert.deepEqual(await jellyfin.fetch(ctx), {});
  assert.equal(ctx.nowPlaying?.length, 4);
  // No counts call when no count field is shown.
  assert.deepEqual(up.requests.map((r) => r.url), ["/Sessions"]);
});

test("jellyfin: enableNowPlaying false skips the list and the sessions call when not needed", async () => {
  const cfg: WidgetConfig = { ...owner(up.url), enableNowPlaying: false };
  assert.equal(jellyfin.showsNowPlaying?.(cfg), false);
  up.requests.length = 0;
  const ctx = makeCtx(cfg, ["movies", "songs", "albums"]);
  assert.deepEqual(await jellyfin.fetch(ctx), { movies: 1204, songs: 15022, albums: 1311 });
  assert.equal(ctx.nowPlaying, undefined);
  assert.deepEqual(up.requests.map((r) => r.url), ["/Items/Counts"]);
});

test("jellyfin: quoted booleans are honoured", () => {
  const cfg: WidgetConfig = { type: "jellyfin", key: KEY, enableBlocks: "true", enableNowPlaying: "false" };
  assert.deepEqual(jellyfin.selectFields?.(cfg, ["movies"]), ["movies"]);
  assert.equal(jellyfin.showsNowPlaying?.(cfg), false);
});

test("jellyfin: enableUser and showEpisodeNumber", () => {
  const items = nowPlayingItems(fixture("jellyfin", "sessions") as unknown[], {
    type: "jellyfin",
    enableUser: true,
    showEpisodeNumber: true,
  });
  assert.deepEqual(
    items.map((i) => [i.user, i.subtitle]),
    [
      ["Alex", "2024"],
      ["sam", "Example Artist · Example Album"],
      ["sam", "Sample Show · S02E05"],
      ["zed", undefined],
    ],
  );
});

test("jellyfin: list is stable regardless of upstream order and capped; count stays exact", async () => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({
    Id: `s${String(i).padStart(2, "0")}`,
    UserName: i % 2 ? "Bob" : "amy",
    NowPlayingItem: { Name: `Title ${String(29 - i).padStart(2, "0")}`, Type: "Movie" },
    PlayState: {},
  }));
  const a = nowPlayingItems(sessions, { type: "jellyfin", enableUser: true });
  const b = nowPlayingItems([...sessions].reverse(), { type: "jellyfin", enableUser: true });
  assert.deepEqual(a, b);
  assert.equal(a.length, MAX_NOW_PLAYING);
  assert.equal(a[0]?.user, "amy");
  assert.equal(a[0]?.title, "Title 01");
  const p = await startFakeUpstream({ "GET /Sessions": { json: sessions } });
  try {
    const ctx = makeCtx({ type: "jellyfin", url: p.url, key: KEY }, ["playing"]);
    assert.deepEqual(await jellyfin.fetch(ctx), { playing: 30 });
  } finally {
    await p.close();
  }
});

test("jellyfin: upstream text is cleaned plain text (controls, bidi, length)", () => {
  const [item] = nowPlayingItems(
    [
      {
        UserName: "u",
        NowPlayingItem: {
          Name: `a\u0000b‮⁦c\n\nd ${"x".repeat(500)}`,
          Type: "Episode",
          SeriesName: { toString: "nope" },
          ParentIndexNumber: 1.5,
          IndexNumber: 2,
          RunTimeTicks: 100,
        },
        PlayState: { PositionTicks: 250, IsPaused: "yes" },
      },
    ],
    { type: "jellyfin", showEpisodeNumber: true },
  );
  assert.ok(item);
  assert.match(item.title, /^a b c d x+…$/);
  assert.ok(item.title.length <= 200);
  assert.equal(item.subtitle, undefined); // non-string series, non-integer season
  assert.equal(item.progressPct, 100); // clamped
  assert.equal(item.paused, false); // only a real true means paused
});

test("jellyfin: progress is omitted when runtime is unknown", () => {
  const [item] = nowPlayingItems(
    [{ NowPlayingItem: { Name: "Live", RunTimeTicks: 0 }, PlayState: { PositionTicks: 5 } }],
    { type: "jellyfin" },
  );
  assert.deepEqual(item, { title: "Live", paused: false });
});

test("jellyfin: the list survives the scheduler's sanitiser unchanged", async () => {
  const { sanitizeNowPlaying } = await import("../../src/scheduler.ts");
  const items = nowPlayingItems(fixture("jellyfin", "sessions") as unknown[], { type: "jellyfin", enableUser: true });
  assert.equal(items.length, 4);
  assert.deepEqual(sanitizeNowPlaying(items), items);
});

test("jellyfin: missing counts are null; non-list sessions is bad_response", async () => {
  const p = await startFakeUpstream({
    "GET /Items/Counts": { json: { MovieCount: 3 } },
    "GET /Sessions": { json: { Items: [] } },
  });
  try {
    assert.deepEqual(await jellyfin.fetch(makeCtx({ type: "jellyfin", url: p.url, key: KEY, enableNowPlaying: false }, ["movies", "series"])), {
      movies: 3,
      series: null,
    });
    await expectWidgetError(jellyfin.fetch(makeCtx({ type: "jellyfin", url: p.url, key: KEY }, ["movies"])), "bad_response");
  } finally {
    await p.close();
  }
});

test("jellyfin: common error mapping", async () => {
  await checkCommonErrors(jellyfin, owner("unused") as Omit<WidgetConfig, "url">, KEY);
});

test("jellyfin: validate", () => {
  assert.equal(jellyfin.validate?.(owner("http://x")), null);
  assert.equal(jellyfin.validate?.({ type: "jellyfin", key: KEY, version: 1 }), null);
  assert.match(String(jellyfin.validate?.({ type: "jellyfin", key: KEY, version: 5 })), /version/);
  assert.match(String(jellyfin.validate?.({ type: "jellyfin", key: KEY, enableBlocks: "yes" })), /enableBlocks/);
  assert.match(String(jellyfin.validate?.({ type: "jellyfin" })), /needs `key:`/);
  for (const k of ["enableBlocks", "enableNowPlaying", "enableUser", "enableMediaControl", "showEpisodeNumber", "expandOneStreamToTwoRows", "version"]) {
    assert.ok(jellyfin.configKeys.optional.includes(k), k);
  }
  assert.deepEqual(jellyfin.configKeys.secret, ["key"]);
});
