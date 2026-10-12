import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler, MAX_CONCURRENT, REFRESH_LIMIT_MS, sanitizeNowPlaying, START_JITTER_MS, VIEWER_TTL_MS } from "../../src/scheduler.ts";
import type { Scheduler, SchedulerDeps } from "../../src/scheduler.ts";
import { Store } from "../../src/store.ts";
import { createLogger, setLogSink } from "../../src/log.ts";
import type { BootContext, ConfigService, NormalisedConfig, NormalisedTile, NormalisedWidget, Settings } from "../../src/types.ts";
import type { HttpClient, WidgetPlugin } from "../../src/widgets/types.ts";
import { WidgetError } from "../../src/widgets/types.ts";
import type { CheckOutcome } from "../../src/checks/types.ts";

const SECRET = "sentinel-secret-9f3a";

const settings: Settings = {
  title: "Homelab",
  tlsVerify: false,
  hideErrors: false,
  hideNoCheck: false,
  groupsInitiallyCollapsed: false,
  disableCollapse: false,
  statusIntervalS: 30,
  widgetIntervalS: 30,
};

function widget(over: Partial<NormalisedWidget> = {}): NormalisedWidget {
  return {
    type: "fake",
    supported: true,
    cfg: { type: "fake", url: "http://10.0.0.5:8989/base", key: SECRET },
    fields: ["a", "b"],
    tlsVerify: false,
    hideErrors: false,
    intervalS: 30,
    timeoutS: 10,
    nowPlaying: false,
    ...over,
  };
}

function tile(id: string, over: Partial<NormalisedTile> = {}): NormalisedTile {
  return { id, name: `Tile ${id}`, groupPath: ["G"], hash: `h-${id}`, ...over };
}

function cfg(tiles: NormalisedTile[], rev = 1, s: Partial<Settings> = {}): NormalisedConfig {
  return { rev, settings: { ...settings, ...s }, tiles, secrets: [SECRET] };
}

class FakeConfig implements ConfigService {
  current: NormalisedConfig | null;
  listeners: ((c: NormalisedConfig) => void)[] = [];
  constructor(c: NormalisedConfig | null) {
    this.current = c;
  }
  async start() {}
  async stop() {}
  getPublic(): never {
    throw new Error("unused");
  }
  getNormalised() {
    return this.current;
  }
  onChange(l: (c: NormalisedConfig) => void) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }
  emit(c: NormalisedConfig) {
    this.current = c;
    for (const l of this.listeners) l(c);
  }
}

interface Harness {
  sched: Scheduler;
  store: Store;
  config: FakeConfig;
  clock: { t: number };
  httpCalls: string[];
  pingCalls: string[];
  fetchCalls: string[];
  logs: string[];
}

const ctx: BootContext = {
  options: { theme: "auto", log_level: "debug" },
  paths: { configDir: "/nonexistent-config", dataDir: "/nonexistent-data", sampleDir: "/x", webDir: "/y" },
  configPathDisplay: "/addon_configs/x/",
  log: createLogger(),
};

function harness(
  initial: NormalisedConfig | null,
  opts: { http?: (url: string) => Promise<CheckOutcome> | CheckOutcome; plugin?: Partial<WidgetPlugin>; deps?: SchedulerDeps } = {},
): Harness {
  const clock = { t: Date.parse("2026-10-12T12:00:00Z") };
  const httpCalls: string[] = [];
  const pingCalls: string[] = [];
  const fetchCalls: string[] = [];
  const logs: string[] = [];
  setLogSink((_lvl, line) => logs.push(line));
  const plugin: WidgetPlugin = {
    type: "fake",
    fields: [
      { key: "a", label: "A", format: "number" },
      { key: "b", label: "B", format: "text" },
    ],
    defaultFields: ["a", "b"],
    configKeys: { required: ["url", "key"], optional: [], secret: ["key"] },
    async fetch(c) {
      fetchCalls.push(String(c.cfg.url));
      return { a: 1, b: "two", extra: 3 };
    },
    ...opts.plugin,
  };
  const config = new FakeConfig(initial);
  const store = new Store();
  const sched = createScheduler(ctx, config, store, {
    now: () => clock.t,
    random: () => 0,
    tickMs: 0,
    loadCa: async () => undefined,
    checkHttp: async (url) => {
      httpCalls.push(url);
      return opts.http ? opts.http(url) : { state: "up", kind: "http", httpStatus: 200, latencyMs: 4, host: new URL(url).hostname };
    },
    checkPing: async (host) => {
      pingCalls.push(host);
      return { state: "up", kind: "ping", latencyMs: 1, host };
    },
    findPlugin: (t) => (t === "fake" ? plugin : undefined),
    createHttpClient: () => ({}) as HttpClient,
    ...opts.deps,
  });
  return { sched, store, config, clock, httpCalls, pingCalls, fetchCalls, logs };
}

async function settle(h: Harness) {
  await h.sched.idle();
  await new Promise((r) => setImmediate(r));
  await h.sched.idle();
}

test("scheduler: status checks start after jitter and repeat every statusInterval; widgets wait for a viewer", async (t) => {
  t.after(() => setLogSink(null));
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "http://10.0.0.1/" }, widget: widget() }), tile("p", { check: { kind: "ping", host: "10.0.0.2" } })]));
  await h.sched.start();
  await settle(h);
  // random() = 0 → jitter 0: due immediately.
  assert.deepEqual(h.httpCalls, ["http://10.0.0.1/"]);
  assert.deepEqual(h.pingCalls, ["10.0.0.2"]);
  assert.equal(h.fetchCalls.length, 0, "no viewer yet: no widget fetch");
  assert.deepEqual(h.store.getWidget("a"), { state: "loading" });
  const st = h.store.getStatus("a")!;
  assert.equal(st.state, "up");
  assert.equal(st.checkedAt, "2026-10-12T12:00:00.000Z");

  h.clock.t += 29_000;
  h.sched.tick();
  await settle(h);
  assert.equal(h.httpCalls.length, 1);
  h.clock.t += 1_000;
  h.sched.tick();
  await settle(h);
  assert.equal(h.httpCalls.length, 2);
  await h.sched.stop();
});

test("scheduler: start jitter spreads the first checks over 0-5 s", async (t) => {
  t.after(() => setLogSink(null));
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "http://10.0.0.1/" } })]), { deps: { random: () => 0.999 } });
  await h.sched.start();
  await settle(h);
  assert.equal(h.httpCalls.length, 0);
  h.clock.t += START_JITTER_MS;
  h.sched.tick();
  await settle(h);
  assert.equal(h.httpCalls.length, 1);
  await h.sched.stop();
});

test("scheduler: demand-driven widgets (AC13): first viewer poll fetches at once; polling stops 2 min after the last viewer; status continues", async (t) => {
  t.after(() => setLogSink(null));
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "http://10.0.0.1/" }, widget: widget() })]));
  await h.sched.start();
  await settle(h);
  assert.equal(h.fetchCalls.length, 0);

  h.sched.noteViewer();
  await settle(h);
  assert.equal(h.fetchCalls.length, 1, "immediate round on the first poll after idle");
  const w = h.store.getWidget("a")!;
  assert.equal(w.state, "ok");
  assert.deepEqual(w.values, { a: 1, b: "two" }, "only the selected fields");
  assert.equal(w.lastOkAt, w.updatedAt);

  // Viewer keeps polling for a while: widget polled every 30 s.
  for (let i = 0; i < 4; i++) {
    h.clock.t += 30_000;
    h.sched.noteViewer();
    h.sched.tick();
    await settle(h);
  }
  assert.equal(h.fetchCalls.length, 5);

  // Viewer leaves. Widget polling continues until 120 s after the last poll, then stops.
  const statusBefore = h.httpCalls.length;
  const leftAt = h.clock.t;
  let fetchedAfterTtl = 0;
  for (let s = 0; s < 600; s += 10) {
    h.clock.t += 10_000;
    const before = h.fetchCalls.length;
    h.sched.tick();
    await settle(h);
    if (h.clock.t - leftAt >= VIEWER_TTL_MS) fetchedAfterTtl += h.fetchCalls.length - before;
  }
  assert.equal(fetchedAfterTtl, 0, "no widget fetch after the viewer TTL");
  assert.ok(h.httpCalls.length - statusBefore >= 19, `status checks continued (${h.httpCalls.length - statusBefore})`);

  // Viewer returns: immediate round.
  const before = h.fetchCalls.length;
  h.sched.noteViewer();
  await settle(h);
  assert.equal(h.fetchCalls.length, before + 1);
  await h.sched.stop();
});

test("scheduler: semaphore caps concurrency at 8 and single-flight prevents overlap", async (t) => {
  t.after(() => setLogSink(null));
  let inFlight = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const perUrl = new Map<string, number>();
  const tiles = Array.from({ length: 20 }, (_, i) => tile(`t${i}`, { check: { kind: "http", url: `http://10.0.1.${i}/` } }));
  const h = harness(cfg(tiles), {
    http: (url) =>
      new Promise<CheckOutcome>((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        perUrl.set(url, (perUrl.get(url) ?? 0) + 1);
        release.push(() => {
          inFlight--;
          resolve({ state: "up", kind: "http", httpStatus: 200 });
        });
      }),
  });
  await h.sched.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(inFlight, MAX_CONCURRENT);
  // Ticks while everything is busy must not start the same job twice.
  h.clock.t += 60_000;
  h.sched.tick();
  h.sched.tick();
  while (release.length) {
    release.shift()!();
    await new Promise((r) => setImmediate(r));
  }
  await settle(h);
  assert.equal(peak, MAX_CONCURRENT);
  for (const [url, n] of perUrl) assert.equal(n, 1, url);
  assert.equal(perUrl.size, 20);
  await h.sched.stop();
});

test("scheduler: refresh re-runs everything, sets refreshing until the round finishes, and is limited to 1 per 10 s", async (t) => {
  t.after(() => setLogSink(null));
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "http://10.0.0.1/" }, widget: widget() })]));
  await h.sched.start();
  await settle(h);
  assert.equal(h.httpCalls.length, 1);
  assert.equal(h.fetchCalls.length, 0);

  h.clock.t += 2_000;
  assert.deepEqual(h.sched.requestRefresh(), { accepted: true });
  assert.equal(h.sched.snapshot().refreshing, true);
  await settle(h);
  assert.equal(h.httpCalls.length, 2);
  assert.equal(h.fetchCalls.length, 1, "refresh counts as a viewer and fetches widgets");
  assert.equal(h.sched.snapshot().refreshing, false, "round finished");

  h.clock.t += 3_000;
  assert.deepEqual(h.sched.requestRefresh(), { accepted: false, retryAfterS: 7 });
  h.clock.t += REFRESH_LIMIT_MS;
  assert.deepEqual(h.sched.requestRefresh(), { accepted: true });
  await h.sched.stop();
});

test("scheduler: refreshing clears after 10 s even if a job hangs; a running job re-runs after it finishes", async (t) => {
  t.after(() => setLogSink(null));
  let resolveFirst: (() => void) | undefined;
  let n = 0;
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "http://10.0.0.1/" } })]), {
    http: () =>
      new Promise<CheckOutcome>((resolve) => {
        n++;
        const done = () => resolve({ state: "up", kind: "http", httpStatus: 200 });
        if (n === 1) resolveFirst = done;
        else done();
      }),
  });
  await h.sched.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.deepEqual(h.sched.requestRefresh(), { accepted: true });
  assert.equal(h.sched.snapshot().refreshing, true);
  t.mock.timers.tick(10_000);
  assert.equal(h.sched.snapshot().refreshing, false, "10 s cap");
  t.mock.timers.reset();
  resolveFirst!();
  await settle(h);
  assert.equal(n, 2, "the job that was running during the refresh ran again");
  await h.sched.stop();
});

test("scheduler: downSince is set on the first down and kept while down; cleared when up", async (t) => {
  t.after(() => setLogSink(null));
  let next: CheckOutcome = { state: "down", kind: "http", reason: "http", httpStatus: 502, host: "10.0.0.1" };
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "http://10.0.0.1/" } })]), { http: () => next });
  await h.sched.start();
  await settle(h);
  const first = h.store.getStatus("a")!;
  assert.equal(first.downSince, "2026-10-12T12:00:00.000Z");
  h.clock.t += 30_000;
  next = { state: "down", kind: "http", reason: "timeout", host: "10.0.0.1" };
  h.sched.tick();
  await settle(h);
  assert.equal(h.store.getStatus("a")!.downSince, "2026-10-12T12:00:00.000Z");
  assert.equal(h.store.getStatus("a")!.reason, "timeout");
  h.clock.t += 30_000;
  next = { state: "up", kind: "http", httpStatus: 200 };
  h.sched.tick();
  await settle(h);
  assert.equal(h.store.getStatus("a")!.downSince, undefined);
  assert.ok(h.logs.some((l) => l.includes('"Tile a" is up')));
  await h.sched.stop();
});

test("scheduler: a check that throws becomes unknown/check_failed; secrets in detail are redacted", async (t) => {
  t.after(() => setLogSink(null));
  let mode = "throw";
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "http://10.0.0.1/" } })]), {
    http: () => {
      if (mode === "throw") throw new Error(`boom ${SECRET}`);
      return { state: "down", kind: "http", reason: "tls", detail: `bad ${SECRET}` };
    },
  });
  await h.sched.start();
  await settle(h);
  assert.deepEqual(
    { state: h.store.getStatus("a")!.state, reason: h.store.getStatus("a")!.reason, detail: h.store.getStatus("a")!.detail },
    { state: "unknown", reason: "check_failed", detail: "internal" },
  );
  mode = "detail";
  h.clock.t += 30_000;
  h.sched.tick();
  await settle(h);
  assert.equal(h.store.getStatus("a")!.detail, "bad ••••");
  assert.equal(JSON.stringify(h.sched.snapshot()).includes(SECRET), false);
  assert.equal(h.logs.join("\n").includes(SECRET), false);
  await h.sched.stop();
});

test("scheduler: widget errors map to kinds; transient errors keep last values, auth/config don't", async (t) => {
  t.after(() => setLogSink(null));
  let behaviour: () => Promise<Record<string, number | string | null>> = async () => ({ a: 7, b: "x" });
  const h = harness(cfg([tile("a", { widget: widget() })]), { plugin: { fetch: () => behaviour() } });
  await h.sched.start();
  h.sched.noteViewer();
  await settle(h);
  const ok = h.store.getWidget("a")!;
  assert.equal(ok.state, "ok");

  const step = async () => {
    h.clock.t += 30_000;
    h.sched.noteViewer();
    h.sched.tick();
    await settle(h);
    return h.store.getWidget("a")!;
  };

  behaviour = async () => {
    throw new WidgetError("unreachable", `connect ECONNREFUSED key=${SECRET}`, undefined, "ECONNREFUSED");
  };
  let r = await step();
  assert.equal(r.state, "error");
  assert.deepEqual(r.error, { kind: "unreachable", host: "10.0.0.5" });
  assert.deepEqual(r.values, { a: 7, b: "x" }, "stale values kept");
  assert.equal(r.lastOkAt, ok.lastOkAt);

  behaviour = async () => {
    throw new WidgetError("bad_response", "HTTP 500", 500);
  };
  r = await step();
  assert.deepEqual(r.error, { kind: "bad_response", httpStatus: 500, host: "10.0.0.5" });
  assert.deepEqual(r.values, { a: 7, b: "x" });

  behaviour = async () => {
    throw new WidgetError("auth", "HTTP 401", 401);
  };
  r = await step();
  assert.deepEqual(r.error, { kind: "auth", httpStatus: 401, host: "10.0.0.5" });
  assert.equal(r.values, undefined, "auth drops values");
  assert.equal(r.lastOkAt, ok.lastOkAt);

  behaviour = async () => {
    throw new WidgetError("config", `needs key (got ${SECRET})`);
  };
  r = await step();
  assert.deepEqual(r.error, { kind: "config", message: "needs key (got ••••)", host: "10.0.0.5" });

  behaviour = async () => {
    throw new TypeError("Cannot read properties of undefined");
  };
  r = await step();
  assert.deepEqual(r.error, { kind: "bad_response", host: "10.0.0.5" });

  assert.equal(JSON.stringify(h.sched.snapshot()).includes(SECRET), false);
  assert.equal(h.logs.join("\n").includes(SECRET), false);
  await h.sched.stop();
});

test("scheduler: a plugin that ignores its signal is cut off at the run deadline (3x timeoutS, min 30 s), not below timeoutS", async (t) => {
  t.after(() => setLogSink(null));
  let sawAbort = false;
  const h = harness(cfg([tile("a", { widget: widget({ timeoutS: 20 }) })]), {
    plugin: {
      fetch: (c) =>
        new Promise(() => {
          c.signal.addEventListener("abort", () => {
            sawAbort = true;
          });
        }),
    },
  });
  await h.sched.start();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.sched.noteViewer();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sched.activeJobs, 1);
  t.mock.timers.tick(20_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sched.activeJobs, 1, "still running at timeoutS (each request has its own timeout in HttpClient)");
  assert.equal(sawAbort, false);
  t.mock.timers.tick(40_000);
  t.mock.timers.reset();
  await settle(h);
  assert.equal(h.sched.activeJobs, 0);
  assert.equal(sawAbort, true);
  assert.deepEqual(h.store.getWidget("a")!.error, { kind: "timeout", timeoutS: 20, host: "10.0.0.5" });
  await h.sched.stop();
});

test("scheduler: the plugin context has cfg, fields, signal, HttpClient and setNowPlaying", async (t) => {
  t.after(() => setLogSink(null));
  const client = { json: async () => ({}) } as unknown as HttpClient;
  let factoryArgs: { url: unknown; secrets: readonly string[] } | undefined;
  const h = harness(cfg([tile("a", { widget: widget({ nowPlaying: true, fields: ["b"] }) })]), {
    deps: {
      createHttpClient: (w, env) => {
        factoryArgs = { url: w.cfg.url, secrets: env.secrets ?? [] };
        assert.ok(env.signal instanceof AbortSignal);
        return client;
      },
    },
    plugin: {
      async fetch(c) {
        assert.equal(c.http, client);
        assert.deepEqual(c.fields, ["b"]);
        assert.equal(c.cfg.key, SECRET);
        assert.equal(Object.isFrozen(c.cfg), true);
        assert.equal(c.signal.aborted, false);
        assert.deepEqual(c.net, { tlsVerify: false, ca: undefined, timeoutS: 10, secrets: [SECRET] });
        c.setNowPlaying([
          { title: "<b>Movie</b> &", user: "alice", progressPct: 140, paused: false },
          { title: "" } as never,
          { title: "Ep", subtitle: "Show · S01E02", progressPct: -3 },
        ]);
        return { b: Number.NaN };
      },
    },
  });
  await h.sched.start();
  h.sched.noteViewer();
  await settle(h);
  assert.deepEqual(factoryArgs, { url: "http://10.0.0.5:8989/base", secrets: [SECRET] });
  const r = h.store.getWidget("a")!;
  assert.equal(r.state, "ok");
  assert.deepEqual(r.values, { b: null }, "NaN becomes null");
  assert.deepEqual(r.nowPlaying, [
    { title: "<b>Movie</b> &", user: "alice", progressPct: 100, paused: false },
    { title: "Ep", subtitle: "Show · S01E02", progressPct: 0 },
  ]);
  await h.sched.stop();
});

test("scheduler: nowPlaying tile without a setNowPlaying call reports an empty list", async (t) => {
  t.after(() => setLogSink(null));
  const h = harness(cfg([tile("a", { widget: widget({ nowPlaying: true }) })]));
  await h.sched.start();
  h.sched.noteViewer();
  await settle(h);
  assert.deepEqual(h.store.getWidget("a")!.nowPlaying, []);
  await h.sched.stop();
});

test("scheduler: unsupported and config-error widgets are never fetched", async (t) => {
  t.after(() => setLogSink(null));
  const h = harness(
    cfg([
      tile("u", { widget: widget({ type: "pihole", supported: false }) }),
      tile("m", { widget: widget({ type: "notregistered" }) }),
      tile("c", { widget: widget({ configError: `Fake widget needs \`key:\` ${SECRET}` }) }),
    ]),
  );
  await h.sched.start();
  h.sched.noteViewer();
  await settle(h);
  assert.equal(h.fetchCalls.length, 0);
  assert.deepEqual(h.store.getWidget("u"), { state: "unsupported" });
  assert.deepEqual(h.store.getWidget("m"), { state: "unsupported" });
  const c = h.store.getWidget("c")!;
  assert.equal(c.state, "error");
  assert.deepEqual(c.error, { kind: "config", message: "Fake widget needs `key:` ••••" });
  await h.sched.stop();
});

test("scheduler: config reload keeps unchanged tiles, resets changed ones, drops removed ones and cancels their jobs", async (t) => {
  t.after(() => setLogSink(null));
  const pending: { url: string; signal: AbortSignal }[] = [];
  const h = harness(
    cfg([
      tile("keep", { check: { kind: "http", url: "http://10.0.0.1/" } }),
      tile("change", { check: { kind: "http", url: "http://10.0.0.2/" } }),
      tile("gone", { check: { kind: "http", url: "http://10.0.0.3/" } }),
    ]),
    {
      deps: {
        checkHttp: (url, o) => {
          if (url === "http://10.0.0.3/") {
            return new Promise<CheckOutcome>((resolve) => {
              pending.push({ url, signal: o.signal! });
              o.signal!.addEventListener("abort", () => resolve({ state: "unknown", kind: "http", reason: "check_failed", detail: "cancelled" }));
            });
          }
          return Promise.resolve({ state: "up", kind: "http", httpStatus: 200 });
        },
      },
    },
  );
  await h.sched.start();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const keptResult = h.store.getStatus("keep");
  assert.ok(keptResult);
  assert.ok(h.store.getStatus("change"));
  assert.equal(pending.length, 1);

  h.clock.t += 1_000;
  h.config.emit(
    cfg(
      [
        tile("keep", { check: { kind: "http", url: "http://10.0.0.1/" } }),
        tile("change", { hash: "h-change-2", check: { kind: "ping", host: "10.0.0.9" } }),
        tile("new", { check: { kind: "ping", host: "10.0.0.10" } }),
      ],
      2,
    ),
  );
  assert.equal(pending[0]!.signal.aborted, true, "removed tile's running job aborted");
  await settle(h);
  assert.equal(h.store.getStatus("keep"), keptResult, "unchanged tile keeps its result object");
  assert.equal(h.store.getStatus("gone"), undefined);
  assert.equal(h.store.getStatus("change")!.kind, "ping", "changed tile re-checked immediately");
  assert.equal(h.store.getStatus("new")!.kind, "ping", "new tile checked immediately (no jitter after the first load)");
  assert.deepEqual(h.pingCalls.sort(), ["10.0.0.10", "10.0.0.9"]);
  await h.sched.stop();
});

test("scheduler: settings.statusIntervalS from a reload applies; intervals below 10 s are clamped", async (t) => {
  t.after(() => setLogSink(null));
  const tiles = [tile("a", { check: { kind: "http", url: "http://10.0.0.1/" } })];
  const h = harness(cfg(tiles, 1, { statusIntervalS: 2 }));
  await h.sched.start();
  await settle(h);
  h.clock.t += 9_000;
  h.sched.tick();
  await settle(h);
  assert.equal(h.httpCalls.length, 1, "clamped to 10 s");
  h.clock.t += 1_000;
  h.sched.tick();
  await settle(h);
  assert.equal(h.httpCalls.length, 2);
  h.config.emit(cfg(tiles, 2, { statusIntervalS: 60 }));
  h.clock.t += 59_000;
  h.sched.tick();
  await settle(h);
  assert.equal(h.httpCalls.length, 2, "rescheduled with the new 60 s interval from the last run");
  h.clock.t += 1_000;
  h.sched.tick();
  await settle(h);
  assert.equal(h.httpCalls.length, 3);
  await h.sched.stop();
});

test("scheduler: no config yet means an empty snapshot; config arriving later starts checks", async (t) => {
  t.after(() => setLogSink(null));
  const h = harness(null);
  await h.sched.start();
  h.sched.noteViewer();
  assert.deepEqual(h.sched.snapshot().status, {});
  assert.deepEqual(h.sched.requestRefresh(), { accepted: true });
  assert.equal(h.sched.snapshot().refreshing, false, "nothing to refresh");
  h.config.emit(cfg([tile("a", { check: { kind: "ping", host: "10.0.0.2" } })]));
  await settle(h);
  assert.equal(h.pingCalls.length, 1);
  await h.sched.stop();
});

test("scheduler: tlsVerify and ca.pem are passed to siteMonitor checks", async (t) => {
  t.after(() => setLogSink(null));
  const seen: { tlsVerify: boolean; ca?: string | Buffer }[] = [];
  const ca = "-----BEGIN CERTIFICATE-----fake";
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "https://10.0.0.1/" } })], 1, { tlsVerify: true }), {
    deps: {
      loadCa: async (dir) => (dir === "/nonexistent-config" ? ca : undefined),
      checkHttp: async (_u, o) => {
        seen.push({ tlsVerify: o.tlsVerify, ca: o.ca });
        return { state: "up", kind: "http", httpStatus: 200 };
      },
    },
  });
  await h.sched.start();
  await settle(h);
  assert.deepEqual(seen, [{ tlsVerify: true, ca }]);
  await h.sched.stop();
});

test("scheduler: stop() aborts running jobs and ignores their late results", async (t) => {
  t.after(() => setLogSink(null));
  let signal: AbortSignal | undefined;
  let resolveIt: ((o: CheckOutcome) => void) | undefined;
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "http://10.0.0.1/" } })]), {
    deps: {
      checkHttp: (_u, o) =>
        new Promise<CheckOutcome>((r) => {
          signal = o.signal;
          resolveIt = r;
        }),
    },
  });
  await h.sched.start();
  await new Promise((r) => setImmediate(r));
  await h.sched.stop();
  assert.equal(signal?.aborted, true);
  resolveIt!({ state: "up", kind: "http", httpStatus: 200 });
  await settle(h);
  assert.equal(h.store.getStatus("a"), undefined);
  h.sched.noteViewer();
  h.sched.tick();
  assert.deepEqual(h.sched.requestRefresh(), { accepted: true });
});

test("sanitizeNowPlaying: bounds length and drops junk", () => {
  assert.deepEqual(sanitizeNowPlaying(null), []);
  assert.deepEqual(sanitizeNowPlaying([1, "x", null, { title: 5 }]), []);
  const many = Array.from({ length: 50 }, (_, i) => ({ title: `T${i}` }));
  assert.equal(sanitizeNowPlaying(many).length, 20);
  const long = sanitizeNowPlaying([{ title: "x".repeat(1000), user: 3 }]);
  assert.equal(long[0]!.title.length, 200);
  assert.equal("user" in long[0]!, false);
});

test("scheduler: an unusable ca.pem is a config error for tlsVerify widgets only; checks fall back to system CAs", async (t) => {
  t.after(() => setLogSink(null));
  const seenCa: unknown[] = [];
  const envCa: unknown[] = [];
  const h = harness(
    cfg(
      [
        tile("v", { check: { kind: "http", url: "https://10.0.0.1/" }, widget: widget({ tlsVerify: true }) }),
        tile("n", { widget: widget({ tlsVerify: false }) }),
      ],
      1,
      { tlsVerify: true },
    ),
    {
      deps: {
        loadCa: async () => {
          throw new WidgetError("config", "ca.pem doesn't contain a PEM certificate");
        },
        checkHttp: async (_u, o) => {
          seenCa.push(o.ca);
          return { state: "up", kind: "http", httpStatus: 200 };
        },
        createHttpClient: (_w, env) => {
          envCa.push(env.ca);
          return {} as HttpClient;
        },
      },
    },
  );
  await h.sched.start();
  h.sched.noteViewer();
  await settle(h);
  assert.deepEqual(seenCa, [undefined]);
  assert.deepEqual(h.store.getWidget("v")!.error, { kind: "config", message: "ca.pem doesn't contain a PEM certificate", host: "10.0.0.5" });
  assert.equal(h.store.getWidget("n")!.state, "ok");
  assert.deepEqual(envCa, [undefined]);
  assert.ok(h.logs.some((l) => l.includes("ca.pem doesn't contain")));
  await h.sched.stop();
});

test("scheduler: no job starts until ca.pem has loaded", async (t) => {
  t.after(() => setLogSink(null));
  let release: ((v: string | undefined) => void) | undefined;
  const h = harness(cfg([tile("a", { check: { kind: "http", url: "https://10.0.0.1/" } })]), {
    deps: { loadCa: () => new Promise((r) => (release = r)) },
  });
  await h.sched.start();
  await settle(h);
  assert.equal(h.httpCalls.length, 0);
  release!(undefined);
  await settle(h);
  assert.equal(h.httpCalls.length, 1);
  await h.sched.stop();
});
