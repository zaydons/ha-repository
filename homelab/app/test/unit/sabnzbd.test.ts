import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { sabnzbd } from "../../src/widgets/sabnzbd.ts";
import { WidgetError } from "../../src/widgets/types.ts";
import { fixture, makeCtx, runPlugin, startFakeUpstream } from "../helpers/fake-upstream.ts";
import type { RouteSpec } from "../helpers/fake-upstream.ts";
import { createLogger, setLogLevel, setLogSecrets, setLogSink } from "../../src/log.ts";

const KEY = "FAKE-sabnzbd-key-0123456789";

async function withUpstream<T>(route: RouteSpec, fn: (url: string, seen: () => string[]) => Promise<T>): Promise<T> {
  const up = await startFakeUpstream({ "GET /api": route });
  try {
    return await fn(up.url, () => up.requests.map((r) => r.url));
  } finally {
    await up.close();
  }
}

test("sabnzbd: ok fixture maps rate/queue/timeleft; key sent only as the apikey query param", async () => {
  await withUpstream({ json: fixture("sabnzbd", "ok") }, async (url, seen) => {
    const v = await runPlugin(sabnzbd, { type: "sabnzbd", url, key: KEY });
    assert.deepEqual(v, { rate: Math.round(1.3 * 1024 * 1024), queue: 2, timeleft: "0:16:44" });
    const [req] = seen();
    assert.ok(req);
    const u = new URL(req, "http://x");
    assert.equal(u.pathname, "/api");
    assert.equal(u.searchParams.get("mode"), "queue");
    assert.equal(u.searchParams.get("output"), "json");
    assert.equal(u.searchParams.get("apikey"), KEY);
  });
});

test("sabnzbd: honours fields and keeps a sub-path in the url", async () => {
  const up = await startFakeUpstream({ "GET /sabnzbd/api": { json: fixture("sabnzbd", "ok") } });
  try {
    const v = await runPlugin(sabnzbd, { type: "sabnzbd", url: `${up.url}/sabnzbd/`, key: KEY }, ["timeleft", "queue"]);
    assert.deepEqual(v, { timeleft: "0:16:44", queue: 2 });
    assert.deepEqual(Object.keys(v), ["timeleft", "queue"]);
  } finally {
    await up.close();
  }
});

test("sabnzbd: idle queue gives zero rate", async () => {
  await withUpstream({ json: fixture("sabnzbd", "idle") }, async (url) => {
    assert.deepEqual(await runPlugin(sabnzbd, { type: "sabnzbd", url, key: KEY }), { rate: 0, queue: 0, timeleft: "0:00:00" });
  });
});

test("sabnzbd: missing properties are null; kbpersec is the rate fallback", async () => {
  await withUpstream({ json: fixture("sabnzbd", "partial") }, async (url) => {
    assert.deepEqual(await runPlugin(sabnzbd, { type: "sabnzbd", url, key: KEY }), { rate: null, queue: 5, timeleft: null });
  });
  await withUpstream({ json: { queue: { speed: "??", kbpersec: "2.5", noofslots: "3" } } }, async (url) => {
    assert.deepEqual(await runPlugin(sabnzbd, { type: "sabnzbd", url, key: KEY }), { rate: 2560, queue: 3, timeleft: null });
  });
});

test("sabnzbd: API key errors are auth (JSON and plain-text forms)", async () => {
  for (const route of [
    { json: fixture("sabnzbd", "bad-key") },
    { body: "error: API Key Incorrect\n" },
    { body: "error: API Key Required\n" },
    { status: 401, body: "no" },
    { status: 403, body: "no" },
  ] satisfies RouteSpec[]) {
    await withUpstream(route, async (url) => {
      await assert.rejects(runPlugin(sabnzbd, { type: "sabnzbd", url, key: KEY }), { kind: "auth" });
    });
  }
});

test("sabnzbd: other failures map to bad_response / timeout / unreachable / config", async () => {
  const cases: [RouteSpec, string][] = [
    [{ status: 500, body: "boom" }, "bad_response"],
    [{ body: "<html>not json</html>" }, "bad_response"],
    [{ json: [1, 2] }, "bad_response"],
    [{ json: { status: false, error: "Something else" } }, "bad_response"],
    [{ json: { queue: "nope" } }, "bad_response"],
    [{ status: 302, headers: { location: "http://example.invalid/steal" } }, "bad_response"],
    [{ json: fixture("sabnzbd", "ok"), delayMs: 1500 }, "timeout"],
  ];
  for (const [route, kind] of cases) {
    await withUpstream(route, async (url) => {
      await assert.rejects(runPlugin(sabnzbd, { type: "sabnzbd", url, key: KEY }, undefined, { timeoutS: 0.5 }), { kind });
    });
  }
  // A closed port.
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  await assert.rejects(runPlugin(sabnzbd, { type: "sabnzbd", url: `http://127.0.0.1:${port}`, key: KEY }), {
    kind: "unreachable",
  });
  await assert.rejects(runPlugin(sabnzbd, { type: "sabnzbd", url: "http://127.0.0.1:1" }), { kind: "config" });
});

test("sabnzbd: validate requires a key", () => {
  assert.equal(sabnzbd.validate?.({ type: "sabnzbd", url: "http://h" }), "needs `key:`");
  assert.equal(sabnzbd.validate?.({ type: "sabnzbd", url: "http://h", key: "  " }), "needs `key:`");
  assert.equal(sabnzbd.validate?.({ type: "sabnzbd", url: "http://h", key: KEY }), null);
  assert.deepEqual(sabnzbd.configKeys.secret, ["key"]);
});

test("sabnzbd: the query-param key never reaches a log line or an error, on any path", async () => {
  const lines: string[] = [];
  setLogLevel("debug");
  setLogSecrets([]); // prove the plugin path is clean without the global safety net
  setLogSink((_lvl, line) => lines.push(line));
  const errors: string[] = [];
  try {
    const routes: RouteSpec[] = [
      { json: fixture("sabnzbd", "ok") },
      { json: fixture("sabnzbd", "bad-key") },
      { body: "error: API Key Incorrect" },
      { status: 500, body: `echo ${KEY}` },
      { body: `not json ${KEY}` },
      { status: 401 },
      { status: 301, headers: { location: `http://x/?apikey=${KEY}` } },
      { json: {}, delayMs: 1500 },
      (req, res) => {
        // Echo the request URL (with the key) back in the body.
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: false, error: req.url }));
      },
      (req) => req.socket.destroy(),
    ];
    for (const route of routes) {
      await withUpstream(route, async (url) => {
        // No secrets registered with the client either: only redact()'s apikey rule and path-only messages protect it.
        const ctx = makeCtx({ type: "sabnzbd", url, key: KEY }, sabnzbd.defaultFields, { secrets: [], timeoutS: 0.5, log: createLogger("sab") });
        try {
          await sabnzbd.fetch(ctx);
        } catch (err) {
          assert.ok(err instanceof WidgetError);
          errors.push(`${err.kind} ${err.message} ${err.detail ?? ""}`);
        }
      });
    }
  } finally {
    setLogSink(null);
    setLogLevel("info");
  }
  assert.ok(lines.length > 0, "debug lines were logged");
  assert.ok(errors.length >= 8);
  for (const s of [...lines, ...errors]) assert.ok(!s.includes(KEY), `leaked: ${s}`);
});

test("registry: sabnzbd and truenas are registered next to the other plugins", async () => {
  const { findPlugin, plugins } = await import("../../src/widgets/index.ts");
  assert.equal(findPlugin("sabnzbd"), sabnzbd);
  assert.equal(findPlugin("truenas")?.type, "truenas");
  assert.equal(plugins.length, 10);
});
