import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../src/store.ts";
import type { StatusResult, WidgetResult } from "../../src/types.ts";

const up: StatusResult = { state: "up", kind: "http", httpStatus: 200, checkedAt: "2026-10-12T12:00:00.000Z" };
const ok: WidgetResult = { state: "ok", values: { wanted: 1 }, nowPlaying: [{ title: "T" }] };

test("store: set/get and snapshot shape", () => {
  const s = new Store();
  s.setStatus("a", up);
  s.setWidget("a", ok);
  assert.deepEqual(s.getStatus("a"), up);
  assert.deepEqual(s.getWidget("a"), ok);
  assert.equal(s.getStatus("missing"), undefined);
  const snap = s.snapshot(new Date("2026-10-12T12:00:05Z"));
  assert.equal(snap.now, "2026-10-12T12:00:05.000Z");
  assert.equal(snap.refreshing, false);
  assert.deepEqual(snap.status, { a: up });
  assert.deepEqual(snap.widgets, { a: ok });
  assert.equal("rev" in snap, false);
});

test("store: snapshot is a detached copy", () => {
  const s = new Store();
  s.setWidget("a", structuredClone(ok));
  const snap = s.snapshot();
  snap.widgets.a!.values!.wanted = 99;
  snap.widgets.a!.nowPlaying!.push({ title: "X" });
  assert.equal(s.getWidget("a")!.values!.wanted, 1);
  assert.equal(s.getWidget("a")!.nowPlaying!.length, 1);
});

test("store: retain drops tiles not in the set; deleteTile drops one", () => {
  const s = new Store();
  for (const id of ["a", "b", "c"]) {
    s.setStatus(id, up);
    s.setWidget(id, ok);
  }
  s.retain(new Set(["a", "b"]));
  assert.deepEqual(Object.keys(s.snapshot().status).sort(), ["a", "b"]);
  assert.deepEqual(Object.keys(s.snapshot().widgets).sort(), ["a", "b"]);
  s.deleteTile("a");
  assert.deepEqual(Object.keys(s.snapshot().status), ["b"]);
  assert.deepEqual(Object.keys(s.snapshot().widgets), ["b"]);
  s.retain(new Set());
  assert.deepEqual(s.snapshot().status, {});
});

test("store: refreshing flag", () => {
  const s = new Store();
  s.setRefreshing(true);
  assert.equal(s.isRefreshing(), true);
  assert.equal(s.snapshot().refreshing, true);
  s.setRefreshing(false);
  assert.equal(s.snapshot().refreshing, false);
});
