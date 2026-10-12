import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { audiobookshelf } from "../../src/widgets/audiobookshelf.ts";
import { fixture, runPlugin, startFakeUpstream } from "../helpers/fake-upstream.ts";
import type { FakeUpstream } from "../helpers/fake-upstream.ts";
import { checkCommonErrors, expectWidgetError } from "../helpers/plugin-errors.ts";

const KEY = "FAKE-abs-token-0000";
const cfg = (url: string) => ({ type: "audiobookshelf", url, key: KEY });
let up: FakeUpstream;

before(async () => {
  up = await startFakeUpstream({
    "GET /api/libraries": { json: fixture("audiobookshelf", "libraries") },
    "GET /api/libraries/lib_c1u6t4p45c35rf0nzd/stats": { json: fixture("audiobookshelf", "stats-books") },
    "GET /api/libraries/lib_second_books/stats": { json: fixture("audiobookshelf", "stats-books2") },
    "GET /api/libraries/6f2a6c1e-0d6b-4f7e-9a1b-2c3d4e5f6a7b/stats": { json: fixture("audiobookshelf", "stats-podcasts") },
  });
});
after(() => up.close());

test("audiobookshelf: sums per media type over libraries", async () => {
  up.requests.length = 0;
  const v = await runPlugin(audiobookshelf, cfg(up.url));
  assert.deepEqual(v, {
    podcasts: 12,
    podcastsDuration: 720000,
    books: 150,
    booksDuration: Math.round(3456000.75 + 500000.5),
  });
  for (const r of up.requests) {
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!r.url.includes(KEY));
  }
});

test("audiobookshelf: honours fields (podcast libraries only)", async () => {
  up.requests.length = 0;
  assert.deepEqual(await runPlugin(audiobookshelf, cfg(up.url), ["podcastsDuration"]), { podcastsDuration: 720000 });
  assert.deepEqual(up.requests.map((r) => r.url), [
    "/api/libraries",
    "/api/libraries/6f2a6c1e-0d6b-4f7e-9a1b-2c3d4e5f6a7b/stats",
  ]);
});

test("audiobookshelf: bare array (old servers), no podcast library, unsafe ids skipped", async () => {
  const p = await startFakeUpstream({
    "GET /api/libraries": {
      json: [
        { id: "lib_a", mediaType: "book" },
        { id: "../../api/users", mediaType: "book" },
        { id: "lib_b?x=1", mediaType: "book" },
        { id: "lib_c", mediaType: "comic" },
        "junk",
      ],
    },
    "GET /api/libraries/lib_a/stats": { json: { totalItems: 3, totalDuration: 7200 } },
  });
  try {
    assert.deepEqual(await runPlugin(audiobookshelf, cfg(p.url)), {
      podcasts: 0,
      podcastsDuration: 0,
      books: 3,
      booksDuration: 7200,
    });
    assert.deepEqual(p.requests.map((r) => r.url), ["/api/libraries", "/api/libraries/lib_a/stats"]);
  } finally {
    await p.close();
  }
});

test("audiobookshelf: a stat missing from one library makes that total null", async () => {
  const p = await startFakeUpstream({
    "GET /api/libraries": { json: { libraries: [{ id: "a", mediaType: "book" }, { id: "b", mediaType: "book" }] } },
    "GET /api/libraries/a/stats": { json: { totalItems: 3, totalDuration: 10 } },
    "GET /api/libraries/b/stats": { json: { totalItems: 4 } },
  });
  try {
    assert.deepEqual(await runPlugin(audiobookshelf, cfg(p.url), ["books", "booksDuration"]), { books: 7, booksDuration: null });
  } finally {
    await p.close();
  }
});

test("audiobookshelf: libraries not a list, or stats not an object, is bad_response", async () => {
  const p = await startFakeUpstream({
    "GET /api/libraries": { json: { libraries: "nope" } },
  });
  const q = await startFakeUpstream({
    "GET /api/libraries": { json: { libraries: [{ id: "a", mediaType: "book" }] } },
    "GET /api/libraries/a/stats": { json: [1, 2] },
  });
  try {
    await expectWidgetError(runPlugin(audiobookshelf, cfg(p.url)), "bad_response");
    await expectWidgetError(runPlugin(audiobookshelf, cfg(q.url)), "bad_response");
  } finally {
    await p.close();
    await q.close();
  }
});

test("audiobookshelf: common error mapping", async () => {
  await checkCommonErrors(audiobookshelf, { type: "audiobookshelf", key: KEY }, KEY);
});

test("audiobookshelf: validate", () => {
  assert.equal(audiobookshelf.validate?.(cfg("http://x")), null);
  assert.match(String(audiobookshelf.validate?.({ type: "audiobookshelf", url: "http://x" })), /needs `key:`/);
  assert.deepEqual(audiobookshelf.configKeys.secret, ["key"]);
});
