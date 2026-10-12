import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureConfig, fixtureState, STUB_SCENARIOS } from "../../src/http/stub-fixtures.ts";
import { createStubStateService, parseScenario } from "../../src/http/stubs.ts";
import type { BootContext, Logger, PublicGroup, PublicTile } from "../../src/types.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

function tiles(groups: PublicGroup[]): PublicTile[] {
  return groups.flatMap((g) => [...g.tiles, ...tiles(g.groups)]);
}

test("fixtures: state keys match tiles, checks and widgets", () => {
  const cfg = fixtureConfig("ok", 1, "/addon_configs/x_homelab/", "auto", "2026-10-12T12:00:00.000Z");
  const state = fixtureState(new Date("2026-10-12T12:00:00Z"), false);
  const all = tiles(cfg.groups);
  const ids = new Set(all.map((t) => t.id));
  assert.equal(ids.size, all.length, "tile ids are unique");
  for (const t of all) {
    assert.match(t.id, /^[0-9a-f]{12}$/);
    assert.equal(t.id in state.status, t.check !== "none", `status entry for ${t.name}`);
    assert.equal(t.id in state.widgets, t.widget !== undefined, `widget entry for ${t.name}`);
    if (t.href) assert.match(t.href, /^https?:\/\//);
    const w = state.widgets[t.id];
    if (w?.nowPlaying) assert.equal(t.widget?.nowPlaying, true, `${t.name} has a now-playing list`);
    if (w?.values && t.widget) {
      assert.deepEqual(Object.keys(w.values), t.widget.fields.map((f) => f.key), `${t.name} values match fields`);
    }
  }
  for (const id of [...Object.keys(state.status), ...Object.keys(state.widgets)]) assert.ok(ids.has(id), id);
  // The browser must only ever get relative proxied icon URLs.
  for (const t of all) if (t.icon?.kind === "proxied") assert.match(t.icon.src, /^icons\/(mdi|si|di|sh|local)\/[^/]+$/);
});

test("fixtures: every scenario is a well-formed PublicConfig", () => {
  for (const s of STUB_SCENARIOS) {
    const cfg = fixtureConfig(s, 3, "/addon_configs/x_homelab/", "dark", "2026-10-12T12:00:00.000Z");
    assert.equal(cfg.rev, 3);
    assert.equal(cfg.theme, "dark");
    assert.ok(Array.isArray(cfg.groups) && Array.isArray(cfg.problems));
    if (s === "fatal") assert.ok(cfg.error && cfg.groups.length === 0 && !cfg.usingLastGood);
    if (s === "banner") assert.ok(cfg.error && cfg.groups.length > 0 && cfg.usingLastGood);
    if (s === "welcome") assert.equal(cfg.sampleInUse, true);
  }
  assert.equal(parseScenario("banner"), "banner");
  assert.equal(parseScenario("nope"), "ok");
  assert.equal(parseScenario(undefined), "ok");
});

test("stub state service: refresh rate limit", () => {
  let clock = new Date("2026-10-12T12:00:00Z");
  const ctx = { log: quiet } as unknown as BootContext;
  const svc = createStubStateService(ctx, () => clock);
  assert.deepEqual(svc.requestRefresh(), { accepted: true });
  assert.equal(svc.snapshot().refreshing, true);
  clock = new Date(clock.getTime() + 4000);
  assert.deepEqual(svc.requestRefresh(), { accepted: false, retryAfterS: 6 });
  assert.equal(svc.snapshot().refreshing, false);
  clock = new Date(clock.getTime() + 6000);
  assert.deepEqual(svc.requestRefresh(), { accepted: true });
});
