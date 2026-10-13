import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildHttpServer, parsePort } from "../../src/server.ts";
import { createStubConfigService, createStubIconService, createStubStateService } from "../../src/http/stubs.ts";
import { NONCE_PLACEHOLDER, rewriteBareImports } from "../../src/http/static.ts";
import { isJsonContentType } from "../../src/http/api.ts";
import { CSP, ICON_CSP, pageCsp } from "../../src/http/respond.ts";
import type { BootContext, Logger } from "../../src/types.ts";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

let server: Server;
let port = 0;
let clock = new Date("2026-10-12T12:00:00Z");

before(async () => {
  const ctx: BootContext = {
    options: { log_level: "info" },
    paths: { configDir: "/nonexistent", dataDir: "/nonexistent", sampleDir: join(APP, "sample"), webDir: join(APP, "web") },
    configPathDisplay: "/addon_configs/abcd1234_homelab/",
    log: quiet,
  };
  const services = {
    config: createStubConfigService(ctx, "ok"),
    state: createStubStateService(ctx, () => clock),
    icons: createStubIconService(join(APP, "node_modules")),
  };
  server = buildHttpServer(ctx, services, false);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(() => server.close());

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function req(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test("GET / serves index.html with no-cache and security headers", async () => {
  const r = await req("GET", "/");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/html/);
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["x-frame-options"], undefined);
  assert.match(r.body, /src="static\/app\.js"/);
});

function nonceOf(r: Res): string {
  const m = /script-src 'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(String(r.headers["content-security-policy"]));
  assert.ok(m, "CSP has a script nonce");
  return m[1]!;
}

test("GET /: per-request CSP nonce in the header and on every script tag", async () => {
  const a = await req("GET", "/");
  const b = await req("GET", "/");
  const na = nonceOf(a);
  const nb = nonceOf(b);
  assert.notEqual(na, nb);
  assert.equal(Buffer.from(na, "base64").length, 16);
  assert.equal(a.headers["content-security-policy"], pageCsp(na));
  assert.doesNotMatch(String(a.headers["content-security-policy"]), /script-src[^;]*'self'/);
  assert.ok(!a.body.includes(NONCE_PLACEHOLDER));
  const tags = a.body.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(tags.length >= 1);
  for (const t of tags) assert.ok(t.includes(`nonce="${na}"`), t);
  assert.ok(!a.body.includes(nb));
});

test("every response, including 404, carries the security headers", async () => {
  const r = await req("GET", "/nope");
  assert.equal(r.status, 404);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["content-security-policy"], CSP);
  assert.deepEqual(JSON.parse(r.body), { error: "not_found" });
});

test("static files are served from web/ only; traversal and hidden files are 404", async () => {
  const ok = await req("GET", "/static/app.js");
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers["content-type"]), /javascript/);
  assert.equal(ok.headers["cache-control"], "public, max-age=300");
  for (const p of [
    "/static/../src/server.ts",
    "/static/..%2fsrc%2fserver.ts",
    "/static/%2e%2e/package.json",
    "/static/./app.js",
    "/static//app.js",
    "/static/.hidden.js",
    "/static/app.js%00.css",
    "/static/..%5cpackage.json",
    "/static/%E0%A4%A",
    "/static/nope.js",
    "/static/index", // no known extension
  ]) {
    const r = await req("GET", p);
    assert.equal(r.status, 404, p);
  }
});

test("vendor modules: allowlist only, bare preact import rewritten", async () => {
  for (const n of ["preact", "hooks", "htm"]) {
    const r = await req("GET", `/vendor/${n}.mjs`);
    assert.equal(r.status, 200, n);
    assert.match(String(r.headers["content-type"]), /javascript/);
    assert.doesNotMatch(r.body, /from\s*["']preact["']/);
  }
  assert.match((await req("GET", "/vendor/hooks.mjs")).body, /from"\.\/preact\.mjs"/);
  assert.equal((await req("GET", "/vendor/react.mjs")).status, 404);
  assert.equal((await req("GET", "/vendor/../package.json")).status, 404);
});

test("rewriteBareImports handles both quote styles and leaves others alone", () => {
  assert.equal(rewriteBareImports(`import{a}from"preact";import b from 'preact'`), `import{a}from"./preact.mjs";import b from './preact.mjs'`);
  assert.equal(rewriteBareImports(`from"preact/hooks"`), `from"preact/hooks"`);
});

test("icons: bundled SVG served with the icon CSP; bad set or name is 404", async () => {
  const r = await req("GET", "/icons/mdi/home.svg");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/svg+xml");
  assert.equal(r.headers["content-security-policy"], ICON_CSP);
  for (const p of ["/icons/xx/home.svg", "/icons/mdi/..%2f..%2fpackage.json", "/icons/mdi/.home.svg", "/icons/mdi/nope-nope.svg", "/icons/mdi/a/b.svg", "/icons/di/plex.png"]) {
    assert.equal((await req("GET", p)).status, 404, p);
  }
});

test("api/config returns the PublicConfig with no-store", async () => {
  const r = await req("GET", "/api/config");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  const cfg = JSON.parse(r.body);
  assert.equal(cfg.rev, 1);
  assert.equal(cfg.configPath, "/addon_configs/abcd1234_homelab/");
  assert.ok(Array.isArray(cfg.groups) && cfg.groups.length > 0);
});

test("api/state: rev is the config rev; bad rev is 400", async () => {
  const r = await req("GET", "/api/state?rev=1");
  assert.equal(r.status, 200);
  const s = JSON.parse(r.body);
  assert.equal(s.rev, 1);
  assert.equal(typeof s.status, "object");
  assert.equal(typeof s.widgets, "object");
  assert.equal((await req("GET", "/api/state")).status, 200);
  assert.equal((await req("GET", "/api/state?rev=abc")).status, 400);
  assert.equal((await req("GET", "/api/state?rev=-1")).status, 400);
});

test("api/refresh: JSON content type required, then 202, then 429 with Retry-After", async () => {
  assert.equal((await req("POST", "/api/refresh")).status, 415);
  assert.equal((await req("POST", "/api/refresh", { "Content-Type": "text/plain" }, "{}")).status, 415);
  assert.equal((await req("POST", "/api/refresh", { "Content-Type": "application/x-www-form-urlencoded" }, "a=b")).status, 415);
  const big = await req("POST", "/api/refresh", { "Content-Type": "application/json" }, "x".repeat(5000));
  assert.equal(big.status, 413);

  const ok = await req("POST", "/api/refresh", { "Content-Type": "application/json; charset=utf-8" }, "{}");
  assert.equal(ok.status, 202);
  assert.deepEqual(JSON.parse(ok.body), { accepted: true });
  assert.equal(JSON.parse((await req("GET", "/api/state")).body).refreshing, true);

  clock = new Date(clock.getTime() + 3000);
  const limited = await req("POST", "/api/refresh", { "Content-Type": "application/json" }, "{}");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "7");
  assert.deepEqual(JSON.parse(limited.body), { retryAfterS: 7 });

  clock = new Date(clock.getTime() + 8000);
  assert.equal((await req("POST", "/api/refresh", { "Content-Type": "application/json" }, "{}")).status, 202);
});

test("isJsonContentType", () => {
  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType(" Application/JSON ; charset=utf-8"), true);
  assert.equal(isJsonContentType("application/jsonx"), false);
  assert.equal(isJsonContentType(undefined), false);
});

test("api/health, HEAD support, and 405 with Allow", async () => {
  const h = await req("GET", "/api/health");
  assert.equal(h.status, 200);
  assert.deepEqual(JSON.parse(h.body), { ok: true });
  const head = await req("HEAD", "/api/health");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  const m = await req("POST", "/api/health", { "Content-Type": "application/json" }, "{}");
  assert.equal(m.status, 405);
  assert.equal(m.headers.allow, "GET, HEAD");
  const g = await req("GET", "/api/refresh");
  assert.equal(g.status, 405);
  assert.equal(g.headers.allow, "POST");
  assert.equal((await req("DELETE", "/")).status, 405);
});

test("absolute-form and oversized request targets are rejected", async () => {
  assert.equal((await req("GET", "http://evil.example/api/health")).status, 400);
  assert.equal((await req("GET", "/api/state?x=" + "a".repeat(3000))).status, 414);
});

test("parsePort", () => {
  assert.equal(parsePort(undefined), 8099);
  assert.equal(parsePort("8123"), 8123);
  assert.throws(() => parsePort("0"));
  assert.throws(() => parsePort("80a"));
});
