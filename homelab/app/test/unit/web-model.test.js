// Frontend view model (web/model.js): sanitising, UX copy, states, summaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allProblems,
  announcement,
  codeSegments,
  groupSummary,
  headerSummary,
  health,
  healthChanges,
  nowPlayingView,
  pageMode,
  reloadToast,
  safeHref,
  safeIcon,
  sanitizeConfig,
  sanitizeState,
  statusView,
  tileLabel,
  tileProblems,
  warningCount,
  widgetView,
} from "../../web/model.js";

const NOW = Date.parse("2026-10-12T10:55:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const SETTINGS = { hideNoCheck: false, groupsInitiallyCollapsed: false, disableCollapse: false, statusIntervalS: 30, widgetIntervalS: 30 };
const ctx = (over = {}) => ({ settings: SETTINGS, now: NOW, backendStale: false, lastPollAt: NOW, locale: "en", ...over });

const tile = (over = {}) => ({ id: "t1", name: "Sonarr", icon: { kind: "letter", letter: "S" }, check: "http", ...over });
const widget = (over = {}) => ({
  type: "sonarr",
  supported: true,
  hideErrors: false,
  nowPlaying: false,
  fields: [
    { key: "wanted", label: "Wanted", format: "number" },
    { key: "queued", label: "Queued", format: "number" },
  ],
  ...over,
});

function rawConfig(over = {}) {
  return {
    rev: 3,
    title: "Homelab",
    theme: "auto",
    configPath: "/addon_configs/x_homelab/",
    sampleInUse: false,
    loadedAt: ago(60),
    usingLastGood: false,
    settings: SETTINGS,
    groups: [
      {
        id: "g1",
        name: "Media",
        collapsed: false,
        groups: [{ id: "g2", name: "Sub", collapsed: false, groups: [{ id: "g3", name: "Deep", collapsed: false, groups: [], tiles: [{ id: "t9", name: "Deep tile", check: "none" }] }], tiles: [] }],
        tiles: [{ id: "t1", name: "Sonarr", href: "http://arr.lan:8989/", check: "http", widget: widget() }],
      },
    ],
    problems: [],
    ...over,
  };
}

// ---------------------------------------------------------------- sanitising

test("safeHref allows only http(s) without userinfo", () => {
  assert.equal(safeHref("http://plex.lan:32400/web"), "http://plex.lan:32400/web");
  assert.equal(safeHref("https://nas.lan"), "https://nas.lan/");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "/relative", "//evil.example", "ftp://x", "http://u:p@host/", "", null, 42]) {
    assert.equal(safeHref(bad), undefined, String(bad));
  }
});

test("safeIcon: proxied must be relative icons/..., url must be http(s), else letter", () => {
  assert.deepEqual(safeIcon({ kind: "proxied", src: "icons/mdi/home.svg" }, "Home"), { kind: "img", src: "icons/mdi/home.svg", mono: true });
  assert.deepEqual(safeIcon({ kind: "proxied", src: "icons/mdi/home.svg?c=ff0000" }, "Home"), { kind: "img", src: "icons/mdi/home.svg?c=ff0000", mono: false });
  assert.deepEqual(safeIcon({ kind: "proxied", src: "icons/di/plex.png" }, "Plex"), { kind: "img", src: "icons/di/plex.png", mono: false });
  assert.deepEqual(safeIcon({ kind: "url", src: "https://example.com/x.png" }, "X"), { kind: "img", src: "https://example.com/x.png", mono: false });
  for (const bad of [
    { kind: "proxied", src: "/icons/mdi/home.svg" },
    { kind: "proxied", src: "icons/../src/server.ts" },
    { kind: "proxied", src: "icons/evil/x.svg" },
    { kind: "proxied", src: "https://evil.example/x.svg" },
    { kind: "url", src: "javascript:alert(1)" },
    { kind: "url", src: "data:image/svg+xml,<svg onload=alert(1)>" },
    { kind: "svg", src: "<svg/>" },
    null,
  ]) {
    assert.deepEqual(safeIcon(bad, "plex"), { kind: "letter", letter: "P" }, JSON.stringify(bad));
  }
  assert.deepEqual(safeIcon({ kind: "letter", letter: "zed" }, "x"), { kind: "letter", letter: "Z" });
});

test("sanitizeConfig keeps good data, drops bad tiles, flattens deep groups, rejects junk", () => {
  const raw = rawConfig();
  raw.groups[0].tiles.push({ id: "bad" }, { id: "t2", name: "JS", href: "javascript:alert(1)", check: "weird" });
  const cfg = sanitizeConfig(raw);
  assert.equal(cfg.groups[0].tiles.length, 2);
  const js = cfg.groups[0].tiles[1];
  assert.equal(js.href, undefined, "javascript: href becomes a non-link tile");
  assert.equal(js.check, "none");
  assert.equal(cfg.groups[0].groups[0].groups.length, 0, "deeper nesting flattened");
  assert.equal(cfg.groups[0].groups[0].tiles[0].id, "t9");
  assert.throws(() => sanitizeConfig({}), /api\/config/);
  assert.throws(() => sanitizeConfig(null), /api\/config/);
  assert.throws(() => sanitizeState({ status: {} }), /api\/state/);
  assert.equal(sanitizeConfig(rawConfig({ theme: "neon" })).theme, "auto");
});

test("sanitizeConfig caps fields at 4 and defaults unknown formats", () => {
  const raw = rawConfig();
  raw.groups[0].tiles[0].widget.fields = Array.from({ length: 6 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, format: i === 0 ? "evil" : "number" }));
  const w = sanitizeConfig(raw).groups[0].tiles[0].widget;
  assert.equal(w.fields.length, 4);
  assert.equal(w.fields[0].format, "number");
});

// ---------------------------------------------------------------- status pill

test("status pill: up tooltips for http and ping", () => {
  const up = statusView(tile(), { state: "up", kind: "http", httpStatus: 200, latencyMs: 42, checkedAt: ago(12) }, ctx());
  assert.equal(up.kind, "up");
  assert.equal(up.word, "Up");
  assert.equal(up.tooltip, "Up · HTTP 200 · 42 ms · checked 12s ago");
  const ping = statusView(tile({ check: "ping" }), { state: "up", kind: "ping", latencyMs: 3, checkedAt: ago(12) }, ctx());
  assert.equal(ping.tooltip, "Up · ping 3 ms · checked 12s ago");
});

test("status pill: down reasons use the UX copy, with down-since line", () => {
  const cases = [
    [{ reason: "http", httpStatus: 502 }, "Down · HTTP 502 Bad Gateway · checked 12s ago", "HTTP 502 · 12s ago"],
    [{ reason: "timeout" }, "Down · No response within 5 s · checked 12s ago", "No response · 12s ago"],
    [{ reason: "refused" }, "Down · Connection refused (is the service running?) · checked 12s ago", "Connection refused · 12s ago"],
    [{ reason: "dns", host: "proxmox.lan" }, "Down · Can't resolve hostname proxmox.lan · checked 12s ago", "DNS lookup failed · 12s ago"],
    [{ reason: "ping", host: "192.0.2.20" }, "Down · No ping reply from 192.0.2.20 · checked 12s ago", "No ping reply · 12s ago"],
    [{ reason: "tls", detail: "SELF_SIGNED_CERT_IN_CHAIN" }, "Down · TLS certificate error: SELF_SIGNED_CERT_IN_CHAIN. Set tlsVerify: false if it's self-signed.", "TLS certificate error · 12s ago"],
  ];
  for (const [extra, tooltip, inline] of cases) {
    const v = statusView(tile(), { state: "down", kind: "http", checkedAt: ago(12), ...extra }, ctx());
    assert.equal(v.kind, "down");
    assert.equal(v.tooltip, tooltip);
    assert.equal(v.inline, inline, "inline reason on tiles without stats");
  }
  const since = statusView(tile(), { state: "down", kind: "http", reason: "refused", checkedAt: ago(1), downSince: ago(14 * 60) }, ctx());
  assert.match(since.tooltip, /\nDown since .+ \(14m\)$/);
  const withWidget = statusView(tile({ widget: widget() }), { state: "down", kind: "http", reason: "refused", checkedAt: ago(1) }, ctx());
  assert.equal(withWidget.inline, "Connection refused · just now", "down reason on stats tiles too (UX delta 6)");
});

test("status pill: loading, no check, hidden, unknown, stale backend", () => {
  assert.equal(statusView(tile(), undefined, ctx()).kind, "loading");
  const nocheck = statusView(tile({ check: "none" }), undefined, ctx());
  assert.equal(nocheck.word, "No check");
  assert.match(nocheck.tooltip, /Add siteMonitor: or ping:/);
  assert.equal(statusView(tile({ check: "none" }), undefined, ctx({ settings: { ...SETTINGS, hideNoCheck: true } })).kind, "hidden");
  const unk = statusView(tile(), { state: "unknown", kind: "http", reason: "check_failed", detail: "EPERM", checkedAt: ago(5) }, ctx());
  assert.equal(unk.word, "Unknown");
  assert.equal(unk.tooltip, "Couldn't run the check: permission denied (EPERM). Will retry in 30 s.");
  const odd = statusView(tile(), { state: "unknown", kind: "http", detail: "weird thing", checkedAt: ago(5) }, ctx());
  assert.equal(odd.tooltip, "Couldn't run the check: weird thing. Will retry in 30 s.");
  const stale = statusView(tile(), { state: "up", kind: "http", httpStatus: 200, checkedAt: ago(400) }, ctx({ backendStale: true, lastPollAt: NOW - 300_000 }));
  assert.equal(stale.stale, true);
  assert.equal(stale.tooltip, "Last known: Up · 5m ago. Can't reach the dashboard backend.");
});

// ---------------------------------------------------------------- stats area

test("widget: loading shows labels with skeleton values", () => {
  const v = widgetView(tile({ widget: widget() }), { state: "loading" }, ctx());
  assert.equal(v.kind, "loading");
  assert.deepEqual(v.cells.map((c) => c.label), ["Wanted", "Queued"]);
  assert.equal(v.sr, "Loading Sonarr stats");
  assert.equal(widgetView(tile({ widget: widget() }), undefined, ctx()).kind, "loading");
});

test("widget: ok values, partial values get a dash and tooltip", () => {
  const v = widgetView(tile({ widget: widget() }), { state: "ok", values: { wanted: 3, queued: null } }, ctx());
  assert.equal(v.kind, "ok");
  assert.deepEqual(v.cells.map((c) => c.value), ["3", "—"]);
  assert.equal(v.cells[1].title, "Not reported by Sonarr");
  assert.equal(v.sr, "Wanted 3, Queued not reported");
  assert.equal(v.countsAsIssue, false);
});

test("widget: free-text values are flagged so only they may ellipsize (F-2)", () => {
  const v = widgetView(tile({ widget: widget() }), { state: "ok", values: { wanted: "0:42:10", queued: 1234 } }, ctx());
  assert.deepEqual(v.cells.map((c) => c.text), [true, false]);
  const missing = widgetView(tile({ widget: widget() }), { state: "ok", values: { wanted: "", queued: null } }, ctx());
  assert.deepEqual(missing.cells.map((c) => c.text), [false, false], "a dash is not free text");
  const loading = widgetView(tile({ widget: widget() }), { state: "loading" }, ctx());
  assert.deepEqual(loading.cells.map((c) => c.text), [false, false]);
});

test("widget errors: copy per kind, counted as issues", () => {
  const t = tile({ widget: widget() });
  const msg = (error) => widgetView(t, { state: "error", error }, ctx());
  assert.equal(msg({ kind: "auth", httpStatus: 401 }).message, "Sign-in failed. Check the API key/username for Sonarr in services.yaml.");
  assert.equal(msg({ kind: "unreachable", host: "192.0.2.5" }).message, "Can't reach Sonarr at 192.0.2.5. Check the widget `url`.");
  assert.equal(msg({ kind: "timeout", timeoutS: 10 }).message, "Sonarr didn't answer within 10 s. Retrying in 30 s.");
  const bad = msg({ kind: "bad_response", httpStatus: 200 });
  assert.equal(bad.message, "Sonarr sent a response we couldn't read. Its API version may not be supported.");
  assert.equal(bad.detail, "HTTP 200");
  assert.equal(msg({ kind: "config", message: "Sonarr widget needs `key:`. See docs." }).message, "Sonarr widget needs `key:`. See docs.");
  assert.equal(msg({ kind: "auth" }).countsAsIssue, true);
  assert.equal(msg({ kind: "config" }).sr.includes("`"), false);
  const immich = widgetView(tile({ name: "Immich", widget: widget({ type: "immich" }) }), { state: "error", error: { kind: "auth", httpStatus: 403 } }, ctx());
  assert.equal(immich.message, "Sign-in failed. The Immich API key needs the `server.statistics` permission.");
});

test("widget: transient errors keep last values as stale for 3 intervals, then error", () => {
  const t = tile({ widget: widget() });
  const res = (lastOkS, kind = "timeout") => ({ state: "error", values: { wanted: 1, queued: 2 }, error: { kind }, lastOkAt: ago(lastOkS) });
  const stale = widgetView(t, res(65), ctx());
  assert.equal(stale.kind, "stale");
  assert.equal(stale.staleText, "1m ago");
  assert.match(stale.staleTitle, /^Couldn't refresh\. Showing values from /);
  assert.equal(stale.countsAsIssue, false);
  assert.equal(widgetView(t, res(91), ctx()).kind, "error", "past 3 x 30 s");
  assert.equal(widgetView(t, res(5, "auth"), ctx()).kind, "error", "auth errors show at once");
});

test("widget: hideErrors mutes errors; unsupported is info, not an issue", () => {
  const muted = widgetView(tile({ widget: widget({ hideErrors: true }) }), { state: "error", error: { kind: "auth" } }, ctx());
  assert.equal(muted.kind, "muted");
  assert.equal(muted.message, "—");
  assert.equal(muted.countsAsIssue, false);
  const uns = widgetView(tile({ widget: widget({ type: "proxmox", supported: false, fields: [] }) }), { state: "unsupported" }, ctx());
  assert.equal(uns.kind, "unsupported");
  assert.equal(uns.message, 'The "proxmox" widget isn\'t supported yet. This tile still works as a link.');
  assert.equal(uns.countsAsIssue, false);
  assert.equal(widgetView(tile(), undefined, ctx()).kind, "none");
});

// ---------------------------------------------------------------- now playing

const jf = () => tile({ name: "Jellyfin", widget: widget({ type: "jellyfin", nowPlaying: true }) });
const npFor = (res, c = ctx()) => {
  const t = jf();
  return nowPlayingView(t, res, widgetView(t, res, c), "en");
};

test("now playing: rows, metas, untitled, text kept verbatim (no HTML)", () => {
  const v = npFor({
    state: "ok",
    values: {},
    nowPlaying: [
      { title: "Dune: Part Two", subtitle: "2024 · Movie", user: "alex", progressPct: 42.4 },
      { title: "<b>Not bold</b> & friends", subtitle: "Show", user: "sam", progressPct: 71, paused: true },
    ],
  });
  assert.equal(v.kind, "items");
  assert.equal(v.rows.length, 2);
  assert.deepEqual(v.rows[0], { title: "Dune: Part Two", paused: false, meta: "42%", metaShort: "42%", line2: "alex · 2024 · Movie", pct: 42 });
  assert.equal(v.rows[1].title, "<b>Not bold</b> & friends");
  assert.equal(v.rows[1].meta, "Paused · 71%");
  assert.equal(v.rows[1].metaShort, "Paused");
  assert.equal(v.overflow, "");
  assert.equal(v.sr, "Now playing, 2 streams: Dune: Part Two, 2024 · Movie, alex, 42 percent; <b>Not bold</b> & friends, Show, sam, paused at 71 percent");
  const odd = npFor({ state: "ok", nowPlaying: [{ title: "  ", paused: true }, { title: "X", progressPct: "50" }] });
  assert.equal(odd.rows[0].title, "Untitled");
  assert.equal(odd.rows[0].meta, "Paused");
  assert.equal(odd.rows[1].meta, "");
  assert.equal(odd.rows[1].pct, null);
  assert.equal(odd.rows[1].line2, "");
});

test("now playing: overflow keeps two rows, lists hidden titles", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}` }));
  const v = npFor({ state: "ok", nowPlaying: items });
  assert.equal(v.rows.length, 2);
  assert.equal(v.overflow, "+6 more");
  assert.equal(v.overflowTitle, "Also playing: T2, T3, T4, T5, T6 and 1 more");
  assert.match(v.sr, /^Now playing, 8 streams: T0; T1; /);
  const many = npFor({ state: "ok", nowPlaying: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}` })) });
  assert.match(many.sr, /T9; and 2 more$/);
});

test("now playing: empty, missing list, loading, error, stale, disabled", () => {
  assert.equal(npFor({ state: "ok", nowPlaying: [] }).empty, true);
  assert.equal(npFor({ state: "ok" }).sr, "Nothing playing");
  assert.equal(npFor({ state: "loading" }).kind, "loading");
  const err = npFor({ state: "error", error: { kind: "auth" } });
  assert.equal(err.kind, "error");
  assert.equal(err.sr, "Now playing not available");
  const stale = npFor({ state: "error", error: { kind: "timeout" }, values: { movies: 1 }, nowPlaying: [{ title: "A" }], lastOkAt: ago(30) });
  assert.equal(stale.stale, true);
  assert.equal(stale.rows[0].title, "A");
  const t = tile({ widget: widget() });
  assert.equal(nowPlayingView(t, { state: "ok" }, widgetView(t, { state: "ok" }, ctx())).kind, "none");
});

// ---------------------------------------------------------------- summaries

test("header summary: hidden until loaded and until something reports", () => {
  const cfg = sanitizeConfig(rawConfig());
  const tiles = [cfg.groups[0].tiles[0], cfg.groups[0].groups[0].tiles[0]];
  assert.equal(headerSummary(health(tiles, null, ctx()), false), null);
  const snapLoading = sanitizeState({ rev: 3, now: "", refreshing: false, status: {}, widgets: {} });
  assert.equal(headerSummary(health(tiles, snapLoading, ctx()), true), null);
  const up = sanitizeState({ rev: 3, status: { t1: { state: "up", kind: "http", checkedAt: ago(1) } }, widgets: { t1: { state: "ok", values: {} } } });
  assert.deepEqual(headerSummary(health(tiles, up, ctx()), true), { tone: "ok", text: "All up" });
  const issue = sanitizeState({ rev: 3, status: { t1: { state: "up", kind: "http" } }, widgets: { t1: { state: "error", error: { kind: "auth" } } } });
  assert.deepEqual(headerSummary(health(tiles, issue, ctx()), true), { tone: "warn", text: "1 issue" });
  const down = sanitizeState({ rev: 3, status: { t1: { state: "down", kind: "http" } }, widgets: { t1: { state: "error", error: { kind: "auth" } } } });
  assert.deepEqual(headerSummary(health(tiles, down, ctx()), true), { tone: "down", text: "1 down · 1 issue" });
});

test("group summary: visible and spoken text", () => {
  const g = sanitizeConfig(rawConfig()).groups[0];
  assert.deepEqual(groupSummary(g, new Set(["t1"]), new Set()), { visible: "2 · 1 down", spoken: "Media, 2 services, 1 down", down: 1 });
  assert.deepEqual(groupSummary(g, new Set(), new Set(["t1"])), { visible: "2 · all up", spoken: "Media, 2 services, all up", down: 0 });
  assert.equal(groupSummary(g, new Set(), new Set()).visible, "2");
});

test("live region: only up<->down transitions, C-24 wording", () => {
  const tiles = ["A", "B", "C", "D", "E"].map((n) => tile({ id: n, name: n }));
  const snap = (states) => ({ rev: 1, now: "", refreshing: false, widgets: {}, status: Object.fromEntries(Object.entries(states).map(([k, s]) => [k, { state: s, kind: "http" }])) });
  assert.deepEqual(healthChanges(tiles, null, snap({ A: "down" })), { down: [], up: [] });
  const ch = healthChanges(tiles, snap({ A: "up", B: "up", C: "up", D: "up", E: "down" }), snap({ A: "down", B: "down", C: "down", D: "down", E: "up" }));
  assert.deepEqual(ch, { down: ["A", "B", "C", "D"], up: ["E"] });
  assert.equal(announcement(ch), "A, B, C and 1 more are down. E is back up");
  assert.equal(announcement({ down: ["TrueNAS"], up: [] }), "TrueNAS is down");
  assert.equal(announcement({ down: ["A", "B"], up: [] }), "A and B are down");
  assert.equal(announcement({ down: [], up: [] }), "");
  assert.deepEqual(healthChanges(tiles, snap({ A: "up" }), snap({ A: "unknown" })), { down: [], up: [] });
});

test("tile accessible name", () => {
  const t = tile({ description: "TV automation", href: "http://x.lan/" });
  assert.equal(tileLabel(t, statusView(t, { state: "up", kind: "http" }, ctx())), "Sonarr, Up, TV automation, opens in new tab");
  const s = tile({ check: "none" });
  assert.equal(tileLabel(s, statusView(s, undefined, ctx())), "Sonarr, No check");
});

// ---------------------------------------------------------------- problems

const FATAL = { severity: "error", file: "services.yaml", line: 14, col: 5, code: "yaml.parse", message: "Bad indentation." };
const WARN = { severity: "warning", file: "services.yaml", line: 22, code: "item.href", message: "`href` isn't a valid URL", tileId: "t1" };
const WIDGET = { severity: "warning", file: "services.yaml", line: 30, code: "widget.config", message: "needs key", tileId: "t1" };
const INFO = { severity: "info", file: "services.yaml", line: 12, code: "key.ignored", message: "Ignored", tileId: "t1" };

test("problems: fatal first and de-duplicated, warning count excludes info and fatal", () => {
  const cfg = sanitizeConfig(rawConfig({ error: FATAL, usingLastGood: true, problems: [FATAL, WARN, WIDGET, INFO] }));
  assert.deepEqual(allProblems(cfg).map((p) => p.code), ["yaml.parse", "item.href", "widget.config", "key.ignored"]);
  assert.equal(warningCount(cfg), 2);
  assert.deepEqual(tileProblems(cfg, "t1").map((p) => p.code), ["item.href"], "widget and info problems excluded");
});

test("page mode and reload toast", () => {
  assert.equal(pageMode(sanitizeConfig(rawConfig())), "dashboard");
  assert.equal(pageMode(sanitizeConfig(rawConfig({ groups: [] }))), "empty");
  assert.equal(pageMode(sanitizeConfig(rawConfig({ groups: [], error: FATAL }))), "fatal");
  assert.equal(pageMode(sanitizeConfig(rawConfig({ error: FATAL, usingLastGood: true }))), "dashboard");
  const a = sanitizeConfig(rawConfig());
  assert.equal(reloadToast(null, a), null);
  assert.equal(reloadToast(a, a), null);
  assert.deepEqual(reloadToast(a, sanitizeConfig(rawConfig({ rev: 4 }))), { text: "Config reloaded", showProblems: false });
  assert.deepEqual(reloadToast(a, sanitizeConfig(rawConfig({ rev: 4, problems: [WARN, WIDGET] }))), { text: "Config reloaded with 2 warnings", showProblems: true });
  assert.equal(reloadToast(a, sanitizeConfig(rawConfig({ rev: 4, error: FATAL }))), null, "errors show the banner instead");
});

test("codeSegments splits backtick spans, unbalanced ticks stay literal", () => {
  assert.deepEqual(codeSegments("needs `key:`. See docs."), [
    { code: false, text: "needs " },
    { code: true, text: "key:" },
    { code: false, text: ". See docs." },
  ]);
  assert.deepEqual(codeSegments("a ` b"), [{ code: false, text: "a ` b" }]);
});

// ---------------------------------------------------------------- rework (reviews 18/19, spec deltas)

test("F1: server-clock offset is used for server timestamps, browser clock for polls", async () => {
  const { clockSkew, toClientTime } = await import("../../web/model.js");
  assert.equal(clockSkew(new Date(NOW + 300_000).toISOString(), NOW), 300_000);
  assert.equal(clockSkew("garbage", NOW), 0);
  // Browser 5 min ahead of the server: server time = browser time - 5 min.
  const browser = NOW + 300_000;
  const c = ctx({ now: NOW, clientNow: browser, lastPollAt: browser });
  const v = statusView(tile(), { state: "up", kind: "http", httpStatus: 200, checkedAt: ago(12) }, c);
  assert.equal(v.tooltip, "Up · HTTP 200 · checked 12s ago", "not 5m ago");
  const t = tile({ widget: widget() });
  const stale = widgetView(t, { state: "error", error: { kind: "timeout" }, values: { wanted: 1 }, lastOkAt: ago(60) }, c);
  assert.equal(stale.kind, "stale", "stale window measured on the server clock");
  assert.equal(toClientTime(NOW, c), browser);
  // Browser 5 min behind: still stale within the window, not "just now".
  const behind = ctx({ now: NOW, clientNow: NOW - 300_000, lastPollAt: NOW - 300_000 });
  assert.equal(statusView(tile(), { state: "up", kind: "http", checkedAt: ago(40) }, behind).tooltip, "Up · checked 40s ago");
});

test("F7: backend unreachable turns ok stats stale", () => {
  const t = tile({ widget: widget() });
  const c = ctx({ backendStale: true, lastPollAt: NOW - 120_000 });
  const v = widgetView(t, { state: "ok", values: { wanted: 3, queued: 1 } }, c);
  assert.equal(v.kind, "stale");
  assert.equal(v.staleText, "2m ago");
  assert.match(v.staleTitle, /^Can't reach the dashboard backend\. Showing values from /);
  assert.deepEqual(v.cells.map((x) => x.value), ["3", "1"]);
});

test("D5/L2: stale pill before any successful poll", () => {
  const v = statusView(tile(), { state: "up", kind: "http" }, ctx({ backendStale: true, lastPollAt: 0 }));
  assert.equal(v.tooltip, "Can't reach the dashboard backend.");
});

test("L8: now playing shows the widget error when there is no stats row", () => {
  const t = tile({ name: "Jellyfin", widget: widget({ type: "jellyfin", nowPlaying: true, fields: [] }) });
  const res = { state: "error", error: { kind: "auth" } };
  const v = nowPlayingView(t, res, widgetView(t, res, ctx()), "en");
  assert.equal(v.kind, "error");
  assert.match(v.message, /^Sign-in failed/);
  const withStats = jf();
  assert.equal(nowPlayingView(withStats, res, widgetView(withStats, res, ctx()), "en").message, "", "stats row carries it");
});
