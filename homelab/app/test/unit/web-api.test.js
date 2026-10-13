// API client (web/api.js): relative URLs, refresh contract, error mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, getConfig, getState, postRefresh } from "../../web/api.js";

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => { if (body === undefined) throw new SyntaxError("x"); return body; } };
  };
  fn.calls = calls;
  return fn;
}

test("requests use relative paths, no-store, same-origin, no redirects", async () => {
  const f = fakeFetch(200, { rev: 7, now: "", refreshing: false, status: {}, widgets: {} });
  await getState(7, f);
  assert.equal(f.calls[0].url, "api/state?rev=7");
  assert.equal(f.calls[0].init.cache, "no-store");
  assert.equal(f.calls[0].init.credentials, "same-origin");
  assert.equal(f.calls[0].init.redirect, "error");
  await getState(null, f);
  assert.equal(f.calls[1].url, "api/state");
});

test("getConfig validates the body and maps HTTP errors", async () => {
  await assert.rejects(getConfig(fakeFetch(200, { nope: true })), /Unexpected api\/config/);
  await assert.rejects(getConfig(fakeFetch(500, { error: "x" })), (e) => e instanceof ApiError && e.status === 500);
  await assert.rejects(getConfig(fakeFetch(200, undefined)), /Unexpected/);
});

test("postRefresh: JSON POST, 202 accepted, 429 retry-after (bounded to 10 s), other codes throw", async () => {
  const ok = fakeFetch(202, { accepted: true });
  assert.deepEqual(await postRefresh(ok), { accepted: true });
  assert.equal(ok.calls[0].url, "api/refresh");
  assert.equal(ok.calls[0].init.method, "POST");
  assert.equal(ok.calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(await postRefresh(fakeFetch(429, { retryAfterS: 7 })), { accepted: false, retryAfterS: 7 });
  assert.deepEqual(await postRefresh(fakeFetch(429, { retryAfterS: 9999 })), { accepted: false, retryAfterS: 10 });
  assert.deepEqual(await postRefresh(fakeFetch(429, {})), { accepted: false, retryAfterS: 10 });
  await assert.rejects(postRefresh(fakeFetch(415, {})), /HTTP 415/);
});

test("network failures become ApiError without leaking details", async () => {
  const boom = async () => { throw new TypeError("fetch failed: secret-ish detail"); };
  await assert.rejects(getState(1, boom), (e) => e instanceof ApiError && e.message === "Network error");
});
