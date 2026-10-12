// Fixture tests for the *arr family (design §9: OK, partial, 401, timeout,
// garbage, redirect), plus fields: selection and credential handling.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { sonarr } from "../../src/widgets/sonarr.ts";
import { radarr } from "../../src/widgets/radarr.ts";
import { lidarr } from "../../src/widgets/lidarr.ts";
import { prowlarr } from "../../src/widgets/prowlarr.ts";
import { arrClient, validateArr } from "../../src/widgets/lib/arr.ts";
import { WidgetError } from "../../src/widgets/types.ts";
import type { WidgetPlugin, WidgetValue } from "../../src/widgets/types.ts";
import { fixture, makeCtx, runPlugin, startFakeUpstream } from "../helpers/fake-upstream.ts";
import type { FakeUpstream, RouteSpec } from "../helpers/fake-upstream.ts";

const KEY = "FAKE-arr-api-key-0001";

interface Case {
  plugin: WidgetPlugin;
  ok: Record<string, WidgetValue>;
  partial: Record<string, WidgetValue>;
  /** A field subset and the only endpoint it should hit. */
  subset: { fields: string[]; paths: string[] };
}

const CASES: Case[] = [
  {
    plugin: sonarr,
    ok: { wanted: 17, queued: 2, series: 3 },
    partial: { wanted: null, queued: 0, series: 0 },
    subset: { fields: ["series", "queued"], paths: ["/api/v3/queue", "/api/v3/series"] },
  },
  {
    plugin: radarr,
    ok: { wanted: 2, missing: 3, queued: 3, movies: 2 },
    partial: { wanted: 0, missing: 1, queued: null, movies: 0 },
    subset: { fields: ["queued"], paths: ["/api/v3/queue/status"] },
  },
  {
    plugin: lidarr,
    ok: { wanted: 42, queued: 1, artists: 2 },
    partial: { wanted: 0, queued: null, artists: 0 },
    subset: { fields: ["wanted"], paths: ["/api/v1/wanted/missing"] },
  },
  {
    plugin: prowlarr,
    ok: { numberOfGrabs: 20, numberOfQueries: 200, numberOfFailGrabs: 1, numberOfFailQueries: 10 },
    partial: { numberOfGrabs: 2, numberOfQueries: 15, numberOfFailGrabs: null, numberOfFailQueries: null },
    subset: { fields: ["numberOfFailQueries", "numberOfGrabs"], paths: ["/api/v1/indexerstats"] },
  },
];

function routesFrom(map: unknown): Record<string, RouteSpec> {
  const out: Record<string, RouteSpec> = {};
  for (const [p, body] of Object.entries(map as Record<string, unknown>)) out[`GET ${p}`] = { json: body };
  return out;
}

/** Every endpoint of the fixture answers with the same spec. */
function allRoutes(type: string, spec: RouteSpec): Record<string, RouteSpec> {
  const out: Record<string, RouteSpec> = {};
  for (const p of Object.keys(fixture(type, "ok") as object)) out[p] = spec;
  return out;
}

async function withUpstream<T>(routes: Record<string, RouteSpec>, fn: (u: FakeUpstream) => Promise<T>): Promise<T> {
  const u = await startFakeUpstream(routes);
  try {
    return await fn(u);
  } finally {
    await u.close();
  }
}

async function expectKind(p: Promise<unknown>, kind: string, httpStatus?: number): Promise<WidgetError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof WidgetError, String(err));
    assert.equal(err.kind, kind, err.message);
    if (httpStatus !== undefined) assert.equal(err.httpStatus, httpStatus);
    assert.ok(!err.message.includes(KEY), "error message leaks the key");
    return err;
  }
  assert.fail(`expected ${kind}`);
}

for (const c of CASES) {
  const type = c.plugin.type;
  describe(type, () => {
    let ok: FakeUpstream;
    before(async () => {
      ok = await startFakeUpstream(routesFrom(fixture(type, "ok")));
    });
    after(async () => ok.close());

    test("OK: Homepage field names, default fields in order", async () => {
      const values = await runPlugin(c.plugin, { type, url: ok.url, key: KEY });
      assert.deepEqual(Object.keys(values), c.plugin.defaultFields);
      assert.deepEqual(values, c.ok);
    });

    test("key goes in X-Api-Key, never in the URL", async () => {
      const n = ok.requests.length;
      await runPlugin(c.plugin, { type, url: ok.url, key: KEY });
      const reqs = ok.requests.slice(n);
      assert.ok(reqs.length > 0);
      for (const r of reqs) {
        assert.equal(r.headers["x-api-key"], KEY);
        assert.ok(!r.url.includes(KEY));
      }
    });

    test("fields: only the requested fields, in config order, and only their endpoints", async () => {
      const n = ok.requests.length;
      const values = await runPlugin(c.plugin, { type, url: ok.url, key: KEY }, c.subset.fields);
      assert.deepEqual(Object.keys(values), c.subset.fields);
      for (const f of c.subset.fields) assert.equal(values[f], c.ok[f]);
      const paths = ok.requests.slice(n).map((r) => r.url.split("?")[0]).sort();
      assert.deepEqual(paths, [...c.subset.paths].sort());
    });

    test("works below a sub-path url (reverse proxy)", async () => {
      const prefixed: Record<string, RouteSpec> = {};
      for (const [p, body] of Object.entries(fixture(type, "ok") as object)) prefixed[`GET /${type}${p}`] = { json: body };
      await withUpstream(prefixed, async (u) => {
        assert.deepEqual(await runPlugin(c.plugin, { type, url: `${u.url}/${type}/`, key: KEY }), c.ok);
      });
    });

    test("partial: missing values are null, not errors", async () => {
      await withUpstream(routesFrom(fixture(type, "partial")), async (u) => {
        assert.deepEqual(await runPlugin(c.plugin, { type, url: u.url, key: KEY }), c.partial);
      });
    });

    test("401 maps to auth", async () => {
      await withUpstream(allRoutes(type, { status: 401, json: { error: "Unauthorized" } }), async (u) => {
        await expectKind(runPlugin(c.plugin, { type, url: u.url, key: KEY }), "auth", 401);
      });
    });

    test("timeout maps to timeout", async () => {
      await withUpstream(allRoutes(type, { json: {}, delayMs: 800 }), async (u) => {
        await expectKind(runPlugin(c.plugin, { type, url: u.url, key: KEY }, undefined, { timeoutS: 0.2 }), "timeout");
      });
    });

    test("garbage maps to bad_response", async () => {
      await withUpstream(allRoutes(type, { body: "<html>login</html>", headers: { "content-type": "text/html" } }), async (u) => {
        await expectKind(runPlugin(c.plugin, { type, url: u.url, key: KEY }), "bad_response");
      });
    });

    test("valid JSON of the wrong shape maps to bad_response", async () => {
      await withUpstream(allRoutes(type, { json: "a string" }), async (u) => {
        await expectKind(runPlugin(c.plugin, { type, url: u.url, key: KEY }), "bad_response");
      });
    });

    test("redirect maps to bad_response and is not followed", async () => {
      const n = ok.requests.length;
      await withUpstream(allRoutes(type, { status: 302, headers: { location: `${ok.url}/api/v3/series` } }), async (u) => {
        await expectKind(runPlugin(c.plugin, { type, url: u.url, key: KEY }), "bad_response", 302);
      });
      assert.equal(ok.requests.length, n);
    });

    test("unreachable maps to unreachable", async () => {
      await expectKind(runPlugin(c.plugin, { type, url: "http://127.0.0.1:1", key: KEY }), "unreachable");
    });

    test("missing key: validate() message and config error at fetch", async () => {
      assert.equal(c.plugin.validate?.({ type, url: ok.url }), "needs `key:`");
      assert.equal(c.plugin.validate?.({ type, url: ok.url, key: "  " }), "needs `key:`");
      assert.equal(c.plugin.validate?.({ type, url: ok.url, key: KEY }), null);
      const n = ok.requests.length;
      await expectKind(runPlugin(c.plugin, { type, url: ok.url }), "config");
      assert.equal(ok.requests.length, n);
    });
  });
}

test("arrClient.count prefers totalRecords, falls back to totalCount, clamps", async () => {
  await withUpstream(
    {
      "/api/v3/a": { json: { totalRecords: 5, totalCount: 9 } },
      "/api/v3/b": { json: { totalCount: 9 } },
      "/api/v3/c": { json: { totalRecords: -3 } },
      "/api/v3/d": { json: { totalRecords: "7" } },
      "/api/v3/e": { json: [1, 2] },
    },
    async (u) => {
      const arr = arrClient(makeCtx({ type: "sonarr", url: u.url, key: KEY }, []), "v3");
      assert.equal(await arr.count("a"), 5);
      assert.equal(await arr.count("/b"), 9);
      assert.equal(await arr.count("c"), 0);
      assert.equal(await arr.count("d"), 7);
      await expectKind(arr.count("e"), "bad_response");
      await expectKind(arr.list("a"), "bad_response");
      assert.ok(u.requests.every((r) => r.url.includes("pageSize=1") || r.url.startsWith("/api/v3/a")));
    },
  );
});

test("validateArr rejects non-string keys", () => {
  assert.equal(validateArr({ type: "sonarr", key: 123 }), "needs `key:`");
});
