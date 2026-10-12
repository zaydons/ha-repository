import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { plex } from "../../src/widgets/plex.ts";
import { fixture, makeCtx, runPlugin, startFakeUpstream } from "../helpers/fake-upstream.ts";
import type { FakeUpstream } from "../helpers/fake-upstream.ts";
import { checkCommonErrors, expectWidgetError } from "../helpers/plugin-errors.ts";

const KEY = "FAKE-plex-token-0000";
let up: FakeUpstream;

before(async () => {
  up = await startFakeUpstream({
    "GET /status/sessions": { json: fixture("plex", "sessions") },
    "GET /library/sections": { json: fixture("plex", "sections") },
    "GET /library/sections/1/all": { json: fixture("plex", "section-1") },
    "GET /library/sections/2/all": { json: fixture("plex", "section-2") },
    "GET /library/sections/3/albums": { json: fixture("plex", "section-3-albums") },
    "GET /library/sections/4/all": { json: fixture("plex", "section-4") },
  });
});
after(() => up.close());

test("plex: all default fields from fixtures, Homepage names", async () => {
  up.requests.length = 0;
  const v = await runPlugin(plex, { type: "plex", url: up.url, key: KEY });
  assert.deepEqual(v, { streams: 2, albums: 642, movies: 1204 + 96, tv: 187 });
  for (const r of up.requests) {
    assert.equal(r.headers["x-plex-token"], KEY);
    assert.match(String(r.headers.accept), /application\/json/);
    assert.ok(!r.url.includes(KEY), "token must not be in the URL");
  }
  // Photo section (5) is never scanned; counts ask for zero items.
  assert.ok(!up.requests.some((r) => r.url.startsWith("/library/sections/5")));
  const scan = up.requests.find((r) => r.url.startsWith("/library/sections/1/all"));
  assert.match(scan?.url ?? "", /X-Plex-Container-Start=0/);
  assert.match(scan?.url ?? "", /X-Plex-Container-Size=0/);
});

test("plex: honours fields and skips unneeded calls", async () => {
  up.requests.length = 0;
  assert.deepEqual(await runPlugin(plex, { type: "plex", url: up.url, key: KEY }, ["streams"]), { streams: 2 });
  assert.deepEqual(up.requests.map((r) => r.url), ["/status/sessions"]);

  up.requests.length = 0;
  assert.deepEqual(await runPlugin(plex, { type: "plex", url: up.url, key: KEY }, ["tv", "movies"]), { tv: 187, movies: 1300 });
  const paths = up.requests.map((r) => r.url.split("?")[0]).sort();
  assert.deepEqual(paths, ["/library/sections", "/library/sections/1/all", "/library/sections/2/all", "/library/sections/4/all"]);
});

test("plex: keeps the configured sub-path (reverse proxy)", async () => {
  const sub = await startFakeUpstream({ "GET /plex/status/sessions": { json: { MediaContainer: { size: 0 } } } });
  try {
    assert.deepEqual(await runPlugin(plex, { type: "plex", url: `${sub.url}/plex`, key: KEY }, ["streams"]), { streams: 0 });
  } finally {
    await sub.close();
  }
});

test("plex: partial data gives null, empty library gives 0", async () => {
  const p = await startFakeUpstream({
    "GET /status/sessions": { json: { MediaContainer: { Metadata: [{}, {}, {}] } } },
    "GET /library/sections": {
      json: { MediaContainer: { Directory: [{ key: "7", type: "movie" }, { key: "8", type: "show" }] } },
    },
    "GET /library/sections/7/all": { json: { MediaContainer: { offset: 0 } } },
    "GET /library/sections/8/all": { json: { MediaContainer: { size: 12 } } },
  });
  try {
    const v = await runPlugin(plex, { type: "plex", url: p.url, key: KEY });
    // size missing -> Metadata length; movie section without a size -> unknown; no music -> 0.
    assert.deepEqual(v, { streams: 3, albums: 0, movies: null, tv: 12 });
  } finally {
    await p.close();
  }
});

test("plex: a library with no sections at all", async () => {
  const p = await startFakeUpstream({ "GET /library/sections": { json: { MediaContainer: { size: 0 } } } });
  try {
    assert.deepEqual(await runPlugin(plex, { type: "plex", url: p.url, key: KEY }, ["movies", "tv"]), { movies: 0, tv: 0 });
  } finally {
    await p.close();
  }
});

test("plex: upstream section keys never reach the request path unless numeric", async () => {
  const p = await startFakeUpstream({
    "GET /library/sections": {
      json: {
        MediaContainer: {
          Directory: [
            { key: "../../admin", type: "movie" },
            { key: "/library/sections/1/all?x=", type: "movie" },
            { key: "1%2F..", type: "movie" },
            { key: 9, type: "movie" },
          ],
        },
      },
    },
    "GET /library/sections/9/all": { json: { MediaContainer: { totalSize: 5 } } },
  });
  try {
    assert.deepEqual(await runPlugin(plex, { type: "plex", url: p.url, key: KEY }, ["movies"]), { movies: 5 });
    assert.deepEqual(
      p.requests.map((r) => r.url.split("?")[0]),
      ["/library/sections", "/library/sections/9/all"],
    );
  } finally {
    await p.close();
  }
});

test("plex: missing MediaContainer is bad_response", async () => {
  const p = await startFakeUpstream({ "GET /status/sessions": { json: { foo: 1 } } });
  try {
    await expectWidgetError(runPlugin(plex, { type: "plex", url: p.url, key: KEY }, ["streams"]), "bad_response");
  } finally {
    await p.close();
  }
});

test("plex: common error mapping", async () => {
  await checkCommonErrors(plex, { type: "plex", key: KEY }, KEY);
});

test("plex: config validation and contract", async () => {
  assert.equal(plex.validate?.({ type: "plex", url: "http://x", key: KEY }), null);
  assert.match(String(plex.validate?.({ type: "plex", url: "http://x", key: "" })), /needs `key:`/);
  assert.match(String(plex.validate?.({ type: "plex", url: "http://x", key: 'a"b' })), /can't be sent/);
  assert.deepEqual(plex.configKeys.secret, ["key"]);
  assert.equal(plex.intervalS, 60);
  assert.ok(plex.defaultFields.length <= 4);
  for (const f of plex.defaultFields) assert.ok(plex.fields.some((d) => d.key === f));
  await expectWidgetError(plex.fetch(makeCtx({ type: "plex", url: up.url }, ["streams"])), "config");
});
