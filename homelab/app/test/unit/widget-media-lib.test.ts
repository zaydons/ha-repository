import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlags, credential, flag, mapLimit, parseVersion, plainText, safeId } from "../../src/widgets/lib/media.ts";
import { WidgetError } from "../../src/widgets/types.ts";
import { findPlugin, plugins } from "../../src/widgets/index.ts";

test("flag", () => {
  assert.equal(flag(undefined, true), true);
  assert.equal(flag(false, true), false);
  assert.equal(flag(" FALSE ", true), false);
  assert.equal(flag("true", false), true);
  assert.equal(flag("maybe", false), false);
  assert.equal(flag(1, false), false);
});

test("checkFlags", () => {
  assert.equal(checkFlags({ type: "t", a: true, b: "False", c: null }, ["a", "b", "c", "d"]), null);
  assert.match(String(checkFlags({ type: "t", a: 1 }, ["a"])), /`a` must be true or false/);
});

test("parseVersion", () => {
  assert.equal(parseVersion(undefined, [1, 2], 1), 1);
  assert.equal(parseVersion(2, [1, 2], 1), 2);
  assert.equal(parseVersion(" 2 ", [1, 2], 1), 2);
  assert.equal(parseVersion(3, [1, 2], 1), null);
  assert.equal(parseVersion(1.5, [1, 2], 1), null);
  assert.equal(parseVersion("v2", [1, 2], 1), null);
});

test("plainText", () => {
  assert.equal(plainText("  <b>x</b> &amp; "), "<b>x</b> &amp;");
  assert.equal(plainText("a‮b\u0007c‏d"), "a b c d");
  assert.equal(plainText(2024), "2024");
  assert.equal(plainText(NaN), null);
  assert.equal(plainText("   "), null);
  assert.equal(plainText({}), null);
  assert.equal(plainText("abcdef", 4), "abc…");
});

test("safeId", () => {
  assert.equal(safeId("12"), "12");
  assert.equal(safeId(7), "7");
  assert.equal(safeId("lib_x-1"), "lib_x-1");
  for (const bad of ["", "..", "a/b", "a?b", "a%2F", "a b", -1, 1.5, null, "x".repeat(65)]) assert.equal(safeId(bad), null, String(bad));
});

test("credential", () => {
  assert.equal(credential({ type: "t", key: " FAKE-k " }), "FAKE-k");
  assert.equal(credential({ type: "t", key: 12345 }), "12345");
  for (const key of [undefined, "", 'a"b', "a\nb", "a\\b"]) {
    assert.throws(() => credential({ type: "t", key }), (e: unknown) => e instanceof WidgetError && e.kind === "config");
  }
});

test("mapLimit keeps order and bounds concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.ok(peak <= 2);
  assert.deepEqual(await mapLimit([], 3, async (n: number) => n), []);
});

test("registry has the media plugins", () => {
  for (const t of ["plex", "jellyfin", "audiobookshelf", "immich"]) {
    const p = findPlugin(t);
    assert.ok(p, t);
    assert.ok(p.defaultFields.length <= 4);
    assert.ok(p.configKeys.secret.includes("key"));
    for (const f of p.defaultFields) assert.ok(p.fields.some((d) => d.key === f), `${t}.${f}`);
  }
  const types = plugins.map((p) => p.type);
  assert.equal(new Set(types).size, types.length, "duplicate plugin types");
});

test("owner's media widget blocks (redacted) validate with no unknown keys", () => {
  const COMMON = ["type", "url", "fields", "hideErrors", "tlsVerify", "headers", "version"];
  const blocks = [
    { type: "plex", url: "http://192.0.2.31:32400", key: "xxx" },
    { type: "jellyfin", url: "http://192.0.2.31:8096", version: 2, key: "xxx", enableBlocks: true, enableNowPlaying: true },
    { type: "immich", url: "http://192.0.2.31:30041", version: 2, key: "xxx" },
    { type: "audiobookshelf", url: "http://192.0.2.31:30067", key: "xxx" },
  ];
  for (const b of blocks) {
    const p = findPlugin(b.type);
    assert.ok(p, b.type);
    assert.equal(p.validate?.(b) ?? null, null, b.type);
    const known = new Set([...COMMON, ...p.configKeys.required, ...p.configKeys.optional]);
    for (const k of Object.keys(b)) assert.ok(known.has(k), `${b.type}: unknown key ${k}`);
  }
});
