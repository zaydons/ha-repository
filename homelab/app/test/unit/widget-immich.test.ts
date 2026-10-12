import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { immich, IMMICH_PATHS } from "../../src/widgets/immich.ts";
import { fixture, runPlugin, startFakeUpstream } from "../helpers/fake-upstream.ts";
import type { FakeUpstream } from "../helpers/fake-upstream.ts";
import { checkCommonErrors, expectWidgetError } from "../helpers/plugin-errors.ts";

const KEY = "FAKE-immich-key-0000";
const EXPECTED = { users: 2, photos: 48213, videos: 2290, storage: 412316860416 };
let v1: FakeUpstream;
let v2: FakeUpstream;

before(async () => {
  v1 = await startFakeUpstream({ "GET /api/server-info/statistics": { json: fixture("immich", "statistics") } });
  v2 = await startFakeUpstream({ "GET /api/server/statistics": { json: fixture("immich", "statistics") } });
});
after(async () => {
  await v1.close();
  await v2.close();
});

test("immich: version 1 (default) uses the server-info path", async () => {
  v1.requests.length = 0;
  assert.deepEqual(await runPlugin(immich, { type: "immich", url: v1.url, key: KEY }), EXPECTED);
  assert.deepEqual(v1.requests.map((r) => r.url), [IMMICH_PATHS[1]]);
  assert.equal(v1.requests[0]?.headers["x-api-key"], KEY);
});

test("immich: version 2 (owner config) uses the server path; '2' as a string too", async () => {
  for (const version of [2, "2"]) {
    v2.requests.length = 0;
    assert.deepEqual(await runPlugin(immich, { type: "immich", url: v2.url, key: KEY, version }), EXPECTED);
    assert.deepEqual(v2.requests.map((r) => r.url), [IMMICH_PATHS[2]]);
    assert.ok(!v2.requests[0]?.url.includes(KEY));
  }
});

test("immich: honours fields order and subset", async () => {
  assert.deepEqual(await runPlugin(immich, { type: "immich", url: v2.url, key: KEY, version: 2 }, ["storage", "users"]), {
    storage: 412316860416,
    users: 2,
  });
});

test("immich: wrong version gives a config error with the fix", async () => {
  const e1 = await expectWidgetError(runPlugin(immich, { type: "immich", url: v2.url, key: KEY }), "config", KEY);
  assert.match(e1.message, /version: 2/);
  const e2 = await expectWidgetError(runPlugin(immich, { type: "immich", url: v1.url, key: KEY, version: 2 }), "config", KEY);
  assert.match(e2.message, /version: 1/);
});

test("immich: 403 is auth with the permission hint", async () => {
  const p = await startFakeUpstream({ "/api/server/statistics": { status: 403, json: { message: "Missing permission" } } });
  try {
    const e = await expectWidgetError(runPlugin(immich, { type: "immich", url: p.url, key: KEY, version: 2 }), "auth", KEY);
    assert.match(e.message, /server\.statistics/);
    assert.equal(e.httpStatus, 403);
  } finally {
    await p.close();
  }
});

test("immich: missing properties are null", async () => {
  const p = await startFakeUpstream({ "/api/server/statistics": { json: { photos: "12", usage: null } } });
  try {
    assert.deepEqual(await runPlugin(immich, { type: "immich", url: p.url, key: KEY, version: 2 }), {
      users: null,
      photos: 12,
      videos: null,
      storage: null,
    });
  } finally {
    await p.close();
  }
});

test("immich: common error mapping", async () => {
  await checkCommonErrors(immich, { type: "immich", key: KEY, version: 2 }, KEY);
});

test("immich: validate", () => {
  assert.equal(immich.validate?.({ type: "immich", key: KEY }), null);
  assert.equal(immich.validate?.({ type: "immich", key: KEY, version: 1 }), null);
  assert.match(String(immich.validate?.({ type: "immich", key: KEY, version: 3 })), /version/);
  assert.match(String(immich.validate?.({ type: "immich", key: KEY, version: "two" })), /version/);
  assert.match(String(immich.validate?.({ type: "immich" })), /needs `key:`/);
  assert.deepEqual(immich.configKeys.secret, ["key"]);
});
