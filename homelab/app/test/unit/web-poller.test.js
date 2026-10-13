// Polling controller (web/poller.js) with fake timers and a fake API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FAST_POLL_MS, createPoller } from "../../web/poller.js";
import { POLL_MS } from "../../web/model.js";

const cfg = (rev, extra = {}) => ({
  rev, title: "Homelab", configPath: "", sampleInUse: false, loadedAt: "", usingLastGood: false,
  settings: { hideNoCheck: false, groupsInitiallyCollapsed: false, disableCollapse: false, statusIntervalS: 30, widgetIntervalS: 30 },
  groups: [{ id: "g", name: "G", collapsed: false, groups: [], tiles: [{ id: "t1", name: "NAS", icon: { kind: "letter", letter: "N" }, check: "http" }] }],
  problems: [], ...extra,
});
const snap = (rev, state = "up", refreshing = false) => ({ rev, now: "", refreshing, widgets: {}, status: { t1: { state, kind: "http" } } });

function harness(over = {}) {
  let t = 1_000_000;
  const timers = [];
  const calls = { config: 0, state: 0, refresh: 0 };
  const events = { toasts: [], health: [], changes: 0 };
  const h = {
    hidden: false,
    configs: [cfg(1)],
    states: [snap(1)],
    refreshResult: { accepted: true },
    failState: false,
    timers,
    calls,
    events,
    get now() { return t; },
    /** Run the earliest pending timer, advancing the clock. */
    async step() {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      assert.ok(next, "a timer is scheduled");
      t = Math.max(t, next.at);
      next.fn();
      await flush();
      return next.ms;
    },
  };
  const deps = {
    getConfig: async () => { calls.config++; return h.configs.length > 1 ? h.configs.shift() : h.configs[0]; },
    getState: async () => {
      calls.state++;
      if (h.failState) throw new Error("Network error");
      return h.states.length > 1 ? h.states.shift() : h.states[0];
    },
    postRefresh: async () => { calls.refresh++; return h.refreshResult; },
    now: () => t,
    isHidden: () => h.hidden,
    setTimer: (fn, ms) => { const e = { fn, ms, at: t + ms }; timers.push(e); return e; },
    clearTimer: (e) => { const i = timers.indexOf(e); if (i >= 0) timers.splice(i, 1); },
    onChange: () => { events.changes++; },
    onToast: (x) => events.toasts.push(x),
    onHealthChange: (x) => events.health.push(x),
    ...over,
  };
  h.poller = createPoller(deps);
  return h;
}
const flush = () => new Promise((r) => setImmediate(r));

test("first tick loads config then state, and schedules the 5 s poll", async () => {
  const h = harness();
  h.poller.start();
  await flush();
  assert.equal(h.calls.config, 1);
  assert.equal(h.calls.state, 1);
  const s = h.poller.state;
  assert.equal(s.config.rev, 1);
  assert.equal(s.snap.rev, 1);
  assert.equal(s.lastPollAt, h.now);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, POLL_MS);
});

test("a new rev in api/state refetches api/config and raises the reload toast", async () => {
  const h = harness();
  h.poller.start();
  await flush();
  h.configs = [cfg(2)];
  h.states = [snap(2)];
  await h.step();
  assert.equal(h.calls.config, 2);
  assert.equal(h.poller.state.config.rev, 2);
  assert.deepEqual(h.events.toasts, [{ text: "Config reloaded", showProblems: false }]);
  await h.step();
  assert.equal(h.calls.config, 2, "same rev: no refetch");
});

test("health transitions are reported, the first snapshot is not", async () => {
  const h = harness();
  h.poller.start();
  await flush();
  assert.equal(h.events.health.length, 0);
  h.states = [snap(1, "down")];
  await h.step();
  assert.deepEqual(h.events.health, [{ down: ["NAS"], up: [] }]);
});

test("failures keep the last data, set error, and keep polling", async () => {
  const h = harness();
  h.poller.start();
  await flush();
  const lastOk = h.poller.state.lastPollAt;
  h.failState = true;
  await h.step();
  const s = h.poller.state;
  assert.equal(s.error, "Network error");
  assert.equal(s.snap.rev, 1);
  assert.equal(s.lastPollAt, lastOk);
  assert.equal(h.timers.length, 1, "still scheduled");
  h.failState = false;
  await h.step();
  assert.equal(h.poller.state.error, null);
});

test("config failure before first load is retried", async () => {
  let n = 0;
  const h = harness({ getConfig: async () => { if (n++ === 0) throw new Error("api/config returned HTTP 500"); return cfg(1); } });
  h.poller.start();
  await flush();
  assert.equal(h.poller.state.config, null);
  assert.match(h.poller.state.error, /HTTP 500/);
  await h.step();
  assert.equal(h.poller.state.config.rev, 1);
});

test("hidden panel pauses polling; visible again polls at once", async () => {
  const h = harness();
  h.poller.start();
  await flush();
  h.hidden = true;
  h.poller.visibilityChanged();
  assert.equal(h.timers.length, 0, "timer cleared");
  h.hidden = false;
  h.poller.visibilityChanged();
  await flush();
  assert.equal(h.calls.state, 2);
  assert.equal(h.timers.length, 1);
});

test("manual refresh: busy, fast polls until the server round ends", async () => {
  const h = harness();
  h.poller.start();
  await flush();
  h.states = [snap(1, "up", true), snap(1, "up", true), snap(1, "up", false)];
  await h.poller.refresh();
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.poller.state.refreshBusy, true);
  await h.poller.refresh();
  assert.equal(h.calls.refresh, 1, "no double refresh while busy");
  assert.equal(await h.step(), FAST_POLL_MS);
  assert.equal(h.poller.state.refreshBusy, true);
  await h.step();
  assert.equal(h.poller.state.refreshBusy, true, "server still refreshing");
  await h.step();
  assert.equal(h.poller.state.refreshBusy, false);
  assert.equal(h.timers[0].ms, POLL_MS, "back to the normal interval");
});

test("manual refresh gives up after 10 s even if the server says refreshing", async () => {
  const h = harness();
  h.poller.start();
  await flush();
  h.states = [snap(1, "up", true)];
  await h.poller.refresh();
  for (let i = 0; i < 12 && h.poller.state.refreshBusy; i++) await h.step();
  assert.equal(h.poller.state.refreshBusy, false);
});

test("refresh failure clears busy and reports the error", async () => {
  const h = harness({ postRefresh: async () => { throw new Error("api/refresh returned HTTP 415"); } });
  h.poller.start();
  await flush();
  await h.poller.refresh();
  assert.equal(h.poller.state.refreshBusy, false);
  assert.match(h.poller.state.error, /415/);
});

test("stop() cancels the timer and later ticks do nothing", async () => {
  const h = harness();
  h.poller.start();
  await flush();
  h.poller.stop();
  assert.equal(h.timers.length, 0);
  h.poller.visibilityChanged();
  await flush();
  assert.equal(h.calls.state, 1);
});

test("F1: each successful poll records the server clock offset; configAt is set once", async () => {
  const h = harness();
  h.states = [{ ...snap(1), now: new Date(h.now + 90_000).toISOString() }];
  h.poller.start();
  await flush();
  assert.equal(h.poller.state.skew, 90_000);
  const configAt = h.poller.state.configAt;
  assert.equal(configAt, h.now);
  h.states = [{ ...snap(1), now: "not a time" }];
  await h.step();
  assert.equal(h.poller.state.skew, 0, "unparseable now: no offset");
  assert.equal(h.poller.state.configAt, configAt);
});
