import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Server as TcpServer, Socket } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHttp, isTlsErrorCode } from "../../src/checks/http.ts";

interface Seen {
  method: string;
  url: string;
  auth?: string;
}

let server: Server;
let base = "";
const seen: Seen[] = [];
const hanging = new Set<ServerResponse>();

function handler(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
  const path = (req.url ?? "/").split("?")[0];
  const m = /^\/status\/(\d{3})$/.exec(path ?? "");
  if (m) {
    res.writeHead(Number(m[1]), { Location: "http://elsewhere.invalid/" });
    res.end(req.method === "GET" ? "x".repeat(10_000) : undefined);
    return;
  }
  if (path === "/head-405") {
    res.writeHead(req.method === "HEAD" ? 405 : 200);
    res.end();
    return;
  }
  if (path === "/get-also-500") {
    res.writeHead(req.method === "HEAD" ? 404 : 500);
    res.end();
    return;
  }
  if (path === "/hang") {
    hanging.add(res);
    return;
  }
  res.writeHead(200);
  res.end("ok");
}

function listen(s: Server | TcpServer): Promise<number> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
}

before(async () => {
  server = createServer(handler);
  base = `http://127.0.0.1:${await listen(server)}`;
});

after(() => {
  for (const r of hanging) r.destroy();
  server.closeAllConnections();
  server.close();
});

const opts = { tlsVerify: false, timeoutMs: 10_000 }; // generous: loopback answers in ms; only a hang hits it

test("http check: 200 is up with status, latency and host", async () => {
  const r = await checkHttp(`${base}/`, opts);
  assert.equal(r.state, "up");
  assert.equal(r.kind, "http");
  assert.equal(r.httpStatus, 200);
  assert.equal(typeof r.latencyMs, "number");
  assert.equal(r.host, "127.0.0.1");
  assert.equal(r.reason, undefined);
});

test("http check: 401 and 403 count as up (Homepage parity)", async () => {
  for (const code of [401, 403]) {
    const r = await checkHttp(`${base}/status/${code}`, opts);
    assert.equal(r.state, "up", String(code));
    assert.equal(r.httpStatus, code);
  }
});

test("http check: 3xx is up and the redirect is not followed", async () => {
  seen.length = 0;
  const r = await checkHttp(`${base}/status/302`, opts);
  assert.equal(r.state, "up");
  assert.equal(r.httpStatus, 302);
  assert.deepEqual(
    seen.map((s) => s.method),
    ["HEAD"],
  );
});

test("http check: 404/500/502 are down with reason http after a GET retry", async () => {
  for (const code of [404, 500, 502]) {
    seen.length = 0;
    const r = await checkHttp(`${base}/status/${code}`, opts);
    assert.equal(r.state, "down");
    assert.equal(r.reason, "http");
    assert.equal(r.httpStatus, code);
    assert.deepEqual(
      seen.map((s) => s.method),
      ["HEAD", "GET"],
    );
  }
});

test("http check: HEAD 405 then GET 200 is up", async () => {
  seen.length = 0;
  const r = await checkHttp(`${base}/head-405?x=1`, opts);
  assert.equal(r.state, "up");
  assert.equal(r.httpStatus, 200);
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.url}`),
    ["HEAD /head-405?x=1", "GET /head-405?x=1"],
  );
});

test("http check: the GET status wins when both fail", async () => {
  const r = await checkHttp(`${base}/get-also-500`, opts);
  assert.equal(r.state, "down");
  assert.equal(r.httpStatus, 500);
});

test("http check: timeout", async () => {
  const r = await checkHttp(`${base}/hang`, { tlsVerify: false, timeoutMs: 150 });
  assert.equal(r.state, "down");
  assert.equal(r.reason, "timeout");
  assert.equal(r.host, "127.0.0.1");
});

test("http check: connection refused", async () => {
  const s = createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  const r = await checkHttp(`http://127.0.0.1:${port}/`, opts);
  assert.equal(r.state, "down");
  assert.equal(r.reason, "refused");
});

test("http check: DNS failure", async () => {
  const r = await checkHttp("http://does-not-exist.invalid/", { tlsVerify: false, timeoutMs: 4000 });
  assert.equal(r.state, "down");
  // Some resolvers time out on .invalid instead of answering NXDOMAIN.
  assert.ok(r.reason === "dns" || r.reason === "timeout", r.reason);
  assert.equal(r.host, "does-not-exist.invalid");
});

test("http check: invalid URL or scheme is our failure (unknown)", async () => {
  for (const u of ["not a url", "ftp://host/", "file:///etc/passwd"]) {
    const r = await checkHttp(u, opts);
    assert.equal(r.state, "unknown");
    assert.equal(r.reason, "check_failed");
    assert.equal(r.detail, "invalid_url");
  }
});

test("http check: URL userinfo is sent as Basic auth and never appears in the result", async () => {
  seen.length = 0;
  const r = await checkHttp(`http://sentinel-user:sentinel-pass@127.0.0.1:${new URL(base).port}/`, opts);
  assert.equal(r.state, "up");
  assert.equal(seen[0]?.auth, `Basic ${Buffer.from("sentinel-user:sentinel-pass").toString("base64")}`);
  assert.equal(JSON.stringify(r).includes("sentinel"), false);
});

test("http check: a cancelled check reports check_failed", async () => {
  const ac = new AbortController();
  const p = checkHttp(`${base}/hang`, { tlsVerify: false, timeoutMs: 5000, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(r.state, "unknown");
  assert.equal(r.detail, "cancelled");
});

test("http check: garbage response (protocol error) retries GET and is down/unreachable", async () => {
  let connections = 0;
  const raw = createTcpServer((sock: Socket) => {
    connections++;
    sock.on("error", () => {});
    sock.end("THIS IS NOT HTTP\r\n\r\n");
  });
  const port = await listen(raw);
  try {
    const r = await checkHttp(`http://127.0.0.1:${port}/`, opts);
    assert.equal(r.state, "down");
    assert.equal(r.reason, "unreachable");
    assert.match(r.detail ?? "", /^[A-Z0-9_]+$/);
    assert.equal(connections, 2);
  } finally {
    raw.close();
  }
});

test("isTlsErrorCode", () => {
  for (const c of ["DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"]) {
    assert.equal(isTlsErrorCode(c), true, c);
  }
  for (const c of ["ECONNREFUSED", "ENOTFOUND", "HPE_INVALID_CONSTANT"]) assert.equal(isTlsErrorCode(c), false, c);
});

// TLS: a self-signed server generated with openssl (skipped when openssl is absent).
function makeSelfSigned(): { key: Buffer; cert: Buffer } | null {
  const dir = mkdtempSync(join(tmpdir(), "hl-tls-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("http check: self-signed TLS is up with tlsVerify off, down/tls with it on, up with ca.pem", async (t) => {
  const pair = makeSelfSigned();
  if (!pair) {
    t.skip("openssl not available");
    return;
  }
  const s = createHttpsServer(pair, (_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const port = await listen(s);
  try {
    const url = `https://127.0.0.1:${port}/`;
    const off = await checkHttp(url, { tlsVerify: false, timeoutMs: 10_000 });
    assert.equal(off.state, "up");
    const on = await checkHttp(url, { tlsVerify: true, timeoutMs: 10_000 });
    assert.equal(on.state, "down");
    assert.equal(on.reason, "tls");
    assert.equal(on.detail, "DEPTH_ZERO_SELF_SIGNED_CERT");
    const withCa = await checkHttp(url, { tlsVerify: true, ca: pair.cert, timeoutMs: 10_000 });
    assert.equal(withCa.state, "up", JSON.stringify(withCa));
  } finally {
    s.closeAllConnections();
    s.close();
  }
});
