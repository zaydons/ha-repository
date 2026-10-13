// Component rendering (web/components/*) without a DOM: the vendor imports
// are mapped to node_modules, function components are expanded into a plain
// tree, and the tree is checked for link safety, text-only rendering and the
// fixed-size slots (UX §4.3, §14.5).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const VENDOR = { preact: "preact", hooks: "preact/hooks", htm: "htm" };
registerHooks({
  resolve(specifier, context, next) {
    const m = /(?:^|\/)vendor\/(preact|hooks|htm)\.mjs$/.exec(specifier);
    return next(m ? VENDOR[m[1]] : specifier, context);
  },
});

let Tile, Fragment, model;
before(async () => {
  ({ Tile } = await import("../../web/components/Tile.js"));
  ({ Fragment } = await import("preact"));
  model = await import("../../web/model.js");
});

/** Expand a Preact vnode into { tag, props, children } / strings. */
function expand(v) {
  if (v === null || v === undefined || typeof v === "boolean") return [];
  if (typeof v === "string" || typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(expand);
  if (typeof v.type === "function") {
    if (v.type === Fragment) return expand(v.props.children);
    return expand(v.type(v.props));
  }
  const { children, ...props } = v.props;
  return [{ tag: v.type, props, children: expand(children) }];
}
const all = (nodes, pred, out = []) => {
  for (const n of nodes) if (typeof n === "object") { if (pred(n)) out.push(n); all(n.children, pred, out); }
  return out;
};
const text = (nodes) => nodes.map((n) => (typeof n === "string" ? n : text(n.children))).join("");
const cls = (n) => String(n.props.class ?? "");

const NOW = Date.parse("2026-10-12T10:55:00Z");
const SETTINGS = { hideNoCheck: false, groupsInitiallyCollapsed: false, disableCollapse: false, statusIntervalS: 30, widgetIntervalS: 30 };
const ctx = { settings: SETTINGS, now: NOW, backendStale: false, lastPollAt: NOW, locale: "en" };

function renderTile(rawTile, snap = null, problems = []) {
  const cfg = model.sanitizeConfig({ rev: 1, groups: [{ id: "g", name: "G", tiles: [rawTile] }] });
  const tile = cfg.groups[0].tiles[0];
  return expand(Tile({ tile, snap, ctx, problems }))[0];
}

test("a tile with an http(s) href is one <a target=_blank rel=noopener noreferrer>", () => {
  const root = renderTile({ id: "t1", name: "Plex", href: "http://plex.lan:32400/web", check: "http" });
  assert.equal(root.tag, "a");
  assert.equal(root.props.href, "http://plex.lan:32400/web");
  assert.equal(root.props.target, "_blank");
  assert.equal(root.props.rel, "noopener noreferrer");
  assert.equal(root.props["aria-label"], "Plex, checking status, opens in new tab");
  assert.equal(all(root.children, (n) => n.tag === "a" || n.tag === "button").length, 0, "no nested interactive elements");
});

test("tiles without href, or with a non-http(s) href, render as non-link boxes", () => {
  for (const href of [undefined, "javascript:alert(1)", "data:text/html,<b>x</b>"]) {
    const root = renderTile({ id: "t1", name: "HexOS", href, check: "none" });
    assert.equal(root.tag, "div", String(href));
    assert.equal(root.props.href, undefined);
    assert.equal(root.props.tabindex, "-1");
    assert.equal(all(root.children, (n) => cls(n).includes("tile-open")).length, 0, "no open-in-new icon");
  }
});

test("upstream text with markup is rendered as text, never as elements", () => {
  const probe = "<b>Not bold</b> & friends <img src=x onerror=alert(1)>";
  const root = renderTile(
    { id: "t1", name: probe, description: probe, href: "http://x.lan/", check: "http",
      widget: { type: "jellyfin", supported: true, hideErrors: false, nowPlaying: true, fields: [{ key: "movies", label: probe, format: "number" }] } },
    { rev: 1, now: "", refreshing: false, status: {}, widgets: { t1: { state: "ok", values: { movies: probe }, nowPlaying: [{ title: probe, subtitle: probe, user: probe }] } } },
  );
  assert.equal(all([root], (n) => n.tag === "b" || n.tag === "img" && n.props.src === "x").length, 0);
  assert.ok(text([root]).includes(probe));
  for (const n of all([root], () => true)) {
    for (const k of Object.keys(n.props)) assert.notEqual(k, "dangerouslySetInnerHTML");
  }
});

test("icons render only through <img src> with no referrer, letter fallback otherwise", () => {
  const root = renderTile({ id: "t1", name: "Sonarr", icon: { kind: "proxied", src: "icons/si/sonarr.svg" }, check: "none" });
  const imgs = all([root], (n) => n.tag === "img");
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].props.src, "icons/si/sonarr.svg");
  assert.equal(imgs[0].props.alt, "");
  assert.equal(imgs[0].props.referrerpolicy, "no-referrer");
  const bad = renderTile({ id: "t1", name: "Sonarr", icon: { kind: "url", src: "javascript:alert(1)" }, check: "none" });
  assert.equal(all([bad], (n) => n.tag === "img").length, 0);
  assert.ok(text([bad]).includes("S"));
});

test("stats box: one label and value slot per field in every state", () => {
  const w = { type: "sonarr", supported: true, hideErrors: false, fields: [{ key: "a", label: "A", format: "number" }, { key: "b", label: "B", format: "number" }, { key: "c", label: "C", format: "number" }] };
  const base = { id: "t1", name: "Sonarr", href: "http://x.lan/", check: "http", widget: w };
  const stats = (res) => all([renderTile(base, { rev: 1, now: "", refreshing: false, status: {}, widgets: res ? { t1: res } : {} })], (n) => cls(n).split(" ").includes("stats"))[0];
  const loading = stats(null);
  assert.equal(loading.props["data-n"], 3);
  assert.equal(all([loading], (n) => cls(n) === "stat").length, 3);
  assert.equal(all([loading], (n) => cls(n).includes("skeleton")).length, 3);
  const ok = stats({ state: "ok", values: { a: 1, b: null, c: 1234 } });
  assert.deepEqual(all([ok], (n) => cls(n).startsWith("stat-value")).map((n) => text([n])), ["1", "—", "1,234"]);
  const textOk = stats({ state: "ok", values: { a: 41_234, b: "0:42:10", c: null } });
  assert.deepEqual(all([textOk], (n) => cls(n).startsWith("stat-value")).map((n) => cls(n)), ["stat-value", "stat-value is-text", "stat-value is-missing"]);
  assert.deepEqual(all([textOk], (n) => cls(n).startsWith("stat-value")).map((n) => n.props.title), ["41.2K", "0:42:10", "Not reported by Sonarr"]);
  const err = stats({ state: "error", error: { kind: "auth" } });
  assert.equal(err.props["data-n"], 3, "error keeps the same box");
  assert.match(text([err]), /^Sign-in failed/);
});

test("now playing always renders two fixed row slots", () => {
  const w = { type: "jellyfin", supported: true, hideErrors: false, nowPlaying: true, fields: [{ key: "playing", label: "Playing", format: "number" }] };
  for (const items of [[], [{ title: "A" }], [{ title: "A" }, { title: "B" }, { title: "C" }]]) {
    const root = renderTile({ id: "t1", name: "Jellyfin", href: "http://x.lan/", check: "http", widget: w },
      { rev: 1, now: "", refreshing: false, status: {}, widgets: { t1: { state: "ok", values: { playing: items.length }, nowPlaying: items } } });
    const np = all([root], (n) => cls(n).split(" ")[0] === "np")[0];
    assert.equal(np.props["aria-hidden"], "true");
    assert.equal(all([np], (n) => cls(n) === "np-slot").length, 2, `${items.length} items`);
    if (items.length === 3) assert.ok(text([np]).includes("+1 more"));
    if (items.length === 0) assert.ok(text([np]).includes("Nothing playing"));
  }
});

test("the hidden description carries status, stats and now playing for screen readers", () => {
  const w = { type: "jellyfin", supported: true, hideErrors: false, nowPlaying: true, fields: [{ key: "playing", label: "Playing", format: "number" }] };
  const root = renderTile({ id: "t1", name: "Jellyfin", href: "http://x.lan/", check: "http", widget: w },
    { rev: 1, now: "", refreshing: false, status: { t1: { state: "up", kind: "http", httpStatus: 200, checkedAt: new Date(NOW - 12000).toISOString() } },
      widgets: { t1: { state: "ok", values: { playing: 1 }, nowPlaying: [{ title: "Dune", progressPct: 42 }] } } });
  const desc = all([root], (n) => n.props.id === root.props["aria-describedby"])[0];
  assert.equal(text([desc]), "Up · HTTP 200 · checked 12s ago. Playing 1. Now playing, 1 stream: Dune, 42 percent.");
});

test("delta 7: an item problem on a widget tile shows in the description row; down reason wins", () => {
  const w = { type: "sonarr", supported: true, hideErrors: false, fields: [{ key: "a", label: "A", format: "number" }] };
  const problem = { severity: "warning", file: "services.yaml", line: 22, code: "key.unknown", message: "Unknown key `widgte`.", tileId: "t1" };
  const base = { id: "t1", name: "Sonarr", description: "TV", href: "http://x.lan/", check: "http", widget: w };
  const desc = (snap) => all([renderTile(base, snap, [problem])], (n) => cls(n).startsWith("tile-desc"))[0];
  const cfgRow = desc(null);
  assert.equal(cls(cfgRow), "tile-desc is-config");
  assert.equal(text([cfgRow]), "Config problem: Unknown key widgte.");
  assert.equal(all([cfgRow], (n) => n.tag === "code").length, 1);
  assert.equal(cfgRow.props.title, "Config problem: Unknown key widgte. (services.yaml line 22)");
  const down = desc({ rev: 1, now: "", refreshing: false, widgets: {}, status: { t1: { state: "down", kind: "http", reason: "refused" } } });
  assert.equal(cls(down), "tile-desc is-reason");
  assert.equal(text([down]), "Connection refused");
  const plain = all([renderTile(base, null, [])], (n) => cls(n).startsWith("tile-desc"))[0];
  assert.equal(text([plain]), "TV");
});

test("L8: a now-playing tile without stat fields has no stats box", () => {
  const w = { type: "jellyfin", supported: true, hideErrors: false, nowPlaying: true, fields: [] };
  const root = renderTile({ id: "t1", name: "Jellyfin", href: "http://x.lan/", check: "http", widget: w },
    { rev: 1, now: "", refreshing: false, status: {}, widgets: { t1: { state: "error", error: { kind: "auth" } } } });
  assert.equal(all([root], (n) => cls(n).split(" ").includes("stats")).length, 0);
  assert.equal(cls(root).includes("has-stats"), false);
  assert.match(text(all([root], (n) => cls(n).split(" ")[0] === "np")), /Sign-in failed/);
});

test("F4: the refresh button uses aria-disabled while busy, never disabled", async () => {
  const { Header } = await import("../../web/components/Header.js");
  let clicks = 0;
  const props = { title: "Homelab", summary: null, onSummary() {}, lastPollAt: NOW, now: NOW, stale: false, onRefresh: () => clicks++, chip: null, announcement: "", locale: "en" };
  const busy = expand(Header({ ...props, refreshBusy: true }))[0];
  const btn = all([busy], (n) => cls(n).includes("refresh"))[0];
  assert.equal(btn.props.disabled, undefined);
  assert.equal(btn.props["aria-disabled"], "true");
  btn.props.onClick();
  assert.equal(clicks, 0);
  const idle = all(expand(Header({ ...props, refreshBusy: false })), (n) => cls(n).includes("refresh"))[0];
  idle.props.onClick();
  assert.equal(clicks, 1);
  const never = expand(Header({ ...props, lastPollAt: 0, stale: true, refreshBusy: false }));
  assert.match(text(never), /Can't reach the dashboard backend\. Retrying\./);
});
