import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  createHttpClient,
  createWidgetHttpClient,
  joinUrl,
  loadCaPem,
  mapNetworkError,
  tlsOptions,
  MAX_BODY_BYTES,
} from "../../src/widgets/lib/http-client.ts";
import { WidgetError } from "../../src/widgets/types.ts";
import type { NormalisedWidget } from "../../src/types.ts";
import { startFakeUpstream } from "../helpers/fake-upstream.ts";
import type { FakeUpstream } from "../helpers/fake-upstream.ts";

const KEY = "FAKE-http-client-key-1234";

let up: FakeUpstream;
let other: FakeUpstream;

before(async () => {
  other = await startFakeUpstream({ "/steal": { json: { stolen: true } } });
  up = await startFakeUpstream({
    "GET /sub/api/ok": { json: { hello: "world" } },
    "GET /api/ok": { json: { root: true } },
    "POST /api/echo": (req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(b));
    },
    "HEAD /api/head": { status: 204 },
    "/api/401": { status: 401, json: { error: "Unauthorized" } },
    "/api/403": { status: 403, body: "forbidden" },
    "/api/500": { status: 500, body: "boom" },
    "/api/404ok": { status: 404, json: { gone: true } },
    "/api/garbage": { body: "<html>not json</html>", headers: { "content-type": "text/html" } },
    "/api/slow": { json: {}, delayMs: 1500 },
    "/api/big-declared": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) });
      res.end();
    },
    "/api/big-chunked": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("x".repeat(600));
      res.end("y".repeat(600));
    },
    "/api/gzip": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(JSON.stringify({ zipped: 1 })));
    },
    "/api/badgzip": { body: "definitely not gzip", headers: { "content-encoding": "gzip" } },
    "/api/bom": { body: "﻿{\"a\":1}" },
    "/api/headers": (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.headers)),
  });
});

after(async () => {
  await up.close();
  await other.close();
});

function client(extra: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  return createHttpClient({ baseUrl: up.url, tlsVerify: false, timeoutS: 1, secrets: [KEY], ...extra });
}

async function rejectsKind(p: Promise<unknown>, kind: string, httpStatus?: number): Promise<WidgetError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof WidgetError, `expected WidgetError, got ${String(err)}`);
    assert.equal(err.kind, kind, err.message);
    if (httpStatus !== undefined) assert.equal(err.httpStatus, httpStatus);
    return err;
  }
  assert.fail(`expected rejection with ${kind}`);
}

test("json: OK, keeps the base sub-path, merges query", async () => {
  const c = client({ baseUrl: `${up.url}/sub/` });
  assert.deepEqual(await c.json("/api/ok", { query: { pageSize: 1, x: true } }), { hello: "world" });
  const last = up.requests.at(-1)!;
  assert.equal(last.url, "/sub/api/ok?pageSize=1&x=true");
  // base without trailing slash and path without leading slash both join the same way
  const c2 = client({ baseUrl: `${up.url}/sub` });
  assert.deepEqual(await c2.json("api/ok"), { hello: "world" });
});

test("headers: cfg.headers and request headers are sent; request headers win", async () => {
  const c = client({ headers: { "X-Extra": "1", "X-Api-Key": "cfg" } });
  const h = await c.json<Record<string, string>>("/api/headers", { headers: { "X-Api-Key": KEY } });
  assert.equal(h["x-extra"], "1");
  assert.equal(h["x-api-key"], KEY);
  assert.equal(h["accept"], "application/json");
  assert.ok(h["user-agent"]);
});

test("POST sends a JSON body; HEAD works", async () => {
  const c = client();
  assert.deepEqual(await c.json("/api/echo", { method: "POST", body: { a: [1, 2] } }), { a: [1, 2] });
  const r = await c.raw("/api/head", { method: "HEAD" });
  assert.equal(r.status, 204);
  assert.equal(r.body.length, 0);
});

test("text and raw return bodies; BOM is tolerated by json", async () => {
  const c = client();
  assert.equal(await c.text("/api/garbage"), "<html>not json</html>");
  const r = await c.raw("/api/ok");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/json");
  assert.deepEqual(await c.json("/api/bom"), { a: 1 });
});

test("401 and 403 map to auth", async () => {
  await rejectsKind(client().json("/api/401"), "auth", 401);
  await rejectsKind(client().json("/api/403"), "auth", 403);
});

test("other non-2xx maps to bad_response with the status; okStatuses accepts it", async () => {
  await rejectsKind(client().json("/api/500"), "bad_response", 500);
  await rejectsKind(client().json("/api/nope"), "bad_response", 404);
  assert.deepEqual(await client().json("/api/404ok", { okStatuses: [404] }), { gone: true });
});

test("garbage body maps to bad_response", async () => {
  await rejectsKind(client().json("/api/garbage"), "bad_response");
});

test("redirects are not followed and map to bad_response", async () => {
  const before = other.requests.length;
  const r = await startFakeUpstream({
    "/api/redirect": { status: 302, headers: { location: `${other.url}/steal` }, body: "" },
  });
  try {
    const c = createHttpClient({ baseUrl: r.url, tlsVerify: false, timeoutS: 1 });
    await rejectsKind(c.json("/api/redirect", { headers: { "X-Api-Key": KEY } }), "bad_response", 302);
    assert.equal(other.requests.length, before, "redirect target must not be contacted");
  } finally {
    await r.close();
  }
});

test("timeout maps to timeout", async () => {
  const err = await rejectsKind(client({ timeoutS: 0.2 }).json("/api/slow"), "timeout");
  assert.match(err.message, /Timed out/);
});

test("external abort maps to timeout (cancelled)", async () => {
  const ac = new AbortController();
  const p = client({ signal: ac.signal, timeoutS: 5 }).json("/api/slow");
  setTimeout(() => ac.abort(), 50);
  const err = await rejectsKind(p, "timeout");
  assert.match(err.message, /cancelled/);
  await rejectsKind(client({ signal: ac.signal }).json("/api/ok"), "timeout");
});

test("size cap: declared and streamed bodies over the limit are bad_response", async () => {
  await rejectsKind(client().json("/api/big-declared"), "bad_response");
  await rejectsKind(client({ maxBodyBytes: 1000 }).text("/api/big-chunked"), "bad_response");
  assert.equal((await client({ maxBodyBytes: 2000 }).text("/api/big-chunked")).length, 1200);
});

test("gzip bodies are decoded; corrupt compression is bad_response", async () => {
  assert.deepEqual(await client().json("/api/gzip"), { zipped: 1 });
  await rejectsKind(client().json("/api/badgzip"), "bad_response");
});

test("connection refused maps to unreachable with the code as detail", async () => {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  const err = await rejectsKind(
    createHttpClient({ baseUrl: `http://127.0.0.1:${port}`, tlsVerify: false }).json("/x"),
    "unreachable",
  );
  assert.equal(err.detail, "ECONNREFUSED");
});

test("paths that could leave the configured origin are refused before any request", async () => {
  const c = client();
  const n = up.requests.length;
  for (const p of [
    "http://evil.example/x",
    "https:x",
    "//evil.example/x",
    "/api/../../etc",
    "/api/%2e%2e/x",
    "/api/a%2Fb",
    "\\\\evil",
    "/api/ok\r\nX: y",
    "javascript:alert(1)",
  ]) {
    await rejectsKind(c.json(p), "config");
  }
  assert.equal(up.requests.length, n);
});

test("joinUrl keeps the origin and sub-path", () => {
  const base = new URL("http://h:1/prefix/");
  assert.equal(joinUrl(base, "/api/v3/queue", { page: 1 }).href, "http://h:1/prefix/api/v3/queue?page=1");
  assert.equal(joinUrl(base, "api?x=1&y=2", { y: 3 }).href, "http://h:1/prefix/api?x=1&y=3");
  assert.equal(joinUrl(new URL("http://h:1"), "/a").href, "http://h:1/a");
});

test("bad base URLs and headers are config errors", () => {
  assert.throws(() => createHttpClient({ baseUrl: "not a url", tlsVerify: false }), { kind: "config" });
  assert.throws(() => createHttpClient({ baseUrl: "ftp://h/", tlsVerify: false }), { kind: "config" });
  assert.throws(() => createHttpClient({ baseUrl: "http://u:FAKE-pw@h/", tlsVerify: false }), (e: WidgetError) => {
    assert.equal(e.kind, "config");
    assert.ok(!e.message.includes("FAKE-pw"));
    return true;
  });
  assert.throws(() => createHttpClient({ baseUrl: "http://h/", tlsVerify: false, headers: { "X-A": "a\r\nb" } }), {
    kind: "config",
  });
  assert.throws(() => createHttpClient({ baseUrl: "http://h/", tlsVerify: false, headers: { "Bad Name": "x" } }), {
    kind: "config",
  });
  assert.throws(
    () => createHttpClient({ baseUrl: "http://h/", tlsVerify: false, headers: ["x"] as unknown as Record<string, string> }),
    { kind: "config" },
  );
});

test("error messages never contain secrets or query strings", async () => {
  const c = client();
  const err = await rejectsKind(c.json(`/api/500?apikey=${KEY}`), "bad_response", 500);
  assert.ok(!err.message.includes(KEY));
  assert.ok(!err.message.includes("apikey"));
  const err2 = await rejectsKind(c.json(`/api/garbage?apikey=${KEY}`), "bad_response");
  assert.ok(!err2.message.includes(KEY));
});

test("mapNetworkError: central mapping", () => {
  const e = (code: string) => Object.assign(new Error(`x ${KEY}`), { code });
  for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]) {
    const m = mapNetworkError(e(code));
    assert.equal(m.kind, "unreachable");
    assert.equal(m.detail, code);
  }
  for (const code of ["DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) {
    const m = mapNetworkError(e(code));
    assert.equal(m.kind, "unreachable");
    assert.equal(m.detail, code);
    assert.match(m.message, /TLS/);
  }
  assert.equal(mapNetworkError(Object.assign(new Error("a"), { name: "AbortError" })).kind, "timeout");
  assert.equal(mapNetworkError(e("HPE_INVALID_CONSTANT")).kind, "bad_response");
  const unknown = mapNetworkError(new Error(`weird ${KEY}`), [KEY]);
  assert.equal(unknown.kind, "unreachable");
  assert.ok(!unknown.message.includes(KEY));
  const we = new WidgetError("auth", "x", 401);
  assert.equal(mapNetworkError(we), we);
});

test("tlsOptions: off by default semantics, CA appended to the system roots", () => {
  assert.deepEqual(tlsOptions({ tlsVerify: false, ca: "PEM" }), { rejectUnauthorized: false });
  assert.deepEqual(tlsOptions({ tlsVerify: true }), { rejectUnauthorized: true });
  const withCa = tlsOptions({ tlsVerify: true, ca: "PEM" });
  assert.equal(withCa.rejectUnauthorized, true);
  assert.equal(withCa.ca?.at(-1), "PEM");
  assert.ok((withCa.ca?.length ?? 0) > 1);
});

test("loadCaPem: absent, invalid and valid files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-ca-"));
  try {
    assert.equal(await loadCaPem(dir), undefined);
    writeFileSync(path.join(dir, "ca.pem"), "garbage");
    await rejectsKind(loadCaPem(dir), "config");
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    writeFileSync(path.join(dir, "ca.pem"), pem);
    assert.equal(await loadCaPem(dir), pem);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWidgetHttpClient: binds url, timeout, headers and TLS policy", async () => {
  const w: NormalisedWidget = {
    type: "sonarr",
    supported: true,
    cfg: { type: "sonarr", url: up.url, headers: { "X-From-Cfg": "yes" } },
    fields: [],
    tlsVerify: false,
    hideErrors: false,
    intervalS: 30,
    timeoutS: 1,
    nowPlaying: false,
  };
  const h = await createWidgetHttpClient(w).json<Record<string, string>>("/api/headers");
  assert.equal(h["x-from-cfg"], "yes");
  assert.throws(() => createWidgetHttpClient({ ...w, cfg: { type: "sonarr" } }), { kind: "config" });
});

// --- TLS with a self-signed fake (generated at test time; nothing committed) ---
function makeSelfSigned(): { key: string; cert: string; dir: string } | null {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1",
        "-keyout", path.join(dir, "key.pem"),
        "-out", path.join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(path.join(dir, "key.pem"), "utf8"),
      cert: readFileSync(path.join(dir, "cert.pem"), "utf8"),
      dir,
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

test("TLS: verify off accepts self-signed; on rejects it; on + ca.pem accepts it", async (t) => {
  const cert = makeSelfSigned();
  if (!cert) {
    t.skip("openssl not available");
    return;
  }
  const s = await startFakeUpstream({ "/api/ok": { json: { secure: true } } }, cert);
  try {
    assert.deepEqual(await createHttpClient({ baseUrl: s.url, tlsVerify: false }).json("/api/ok"), { secure: true });
    const err = await rejectsKind(createHttpClient({ baseUrl: s.url, tlsVerify: true }).json("/api/ok"), "unreachable");
    assert.ok(err.detail && /SELF_SIGNED|UNABLE_TO|CERT/.test(err.detail), err.detail);
    assert.deepEqual(await createHttpClient({ baseUrl: s.url, tlsVerify: true, ca: cert.cert }).json("/api/ok"), {
      secure: true,
    });
  } finally {
    await s.close();
    rmSync(cert.dir, { recursive: true, force: true });
  }
});
