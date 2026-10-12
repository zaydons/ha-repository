import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { attachGuard, isAllowedSource, normaliseAddress } from "../../src/http/guard.ts";
import type { Logger } from "../../src/types.ts";

function memLogger(lines: string[]): Logger {
  const l: Logger = {
    debug: (m) => lines.push(`debug ${m}`),
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
    child: () => l,
  };
  return l;
}

test("normaliseAddress: plain IPv4 and IPv6 pass through", () => {
  assert.equal(normaliseAddress("172.30.32.2"), "172.30.32.2");
  assert.equal(normaliseAddress("::1"), "::1");
  assert.equal(normaliseAddress("FE80::1"), "fe80::1");
});

test("normaliseAddress: IPv4-mapped IPv6 becomes IPv4", () => {
  assert.equal(normaliseAddress("::ffff:172.30.32.2"), "172.30.32.2");
  assert.equal(normaliseAddress("::FFFF:127.0.0.1"), "127.0.0.1");
  assert.equal(normaliseAddress("::ffff:ac1e:2002"), "172.30.32.2");
  assert.equal(normaliseAddress("0:0:0:0:0:ffff:ac1e:2002"), "172.30.32.2");
  assert.equal(normaliseAddress("0000:0000:0000:0000:0000:ffff:7f00:0001"), "127.0.0.1");
  assert.equal(normaliseAddress("[::ffff:172.30.32.2]"), "172.30.32.2");
});

test("normaliseAddress: zone ids are dropped", () => {
  assert.equal(normaliseAddress("fe80::1%eth0"), "fe80::1");
});

test("normaliseAddress: garbage is null (fails closed)", () => {
  for (const bad of [undefined, null, 42, "", " ", "localhost", "172.30.32.2.1", "172.30.32", "::ffff:", "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1", "a".repeat(100)]) {
    assert.equal(normaliseAddress(bad), null, String(bad));
  }
});

test("normaliseAddress: a non-mapped IPv6 with ffff elsewhere is not turned into IPv4", () => {
  assert.equal(normaliseAddress("1::ffff:ac1e:2002"), "1::ffff:ac1e:2002");
  assert.equal(normaliseAddress("::fffe:ac1e:2002"), "::fffe:ac1e:2002");
});

test("isAllowedSource: Supervisor and loopback only", () => {
  for (const ok of ["172.30.32.2", "::ffff:172.30.32.2", "127.0.0.1", "::ffff:127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]) {
    assert.equal(isAllowedSource(ok), true, ok);
  }
  for (const bad of ["172.30.32.1", "172.30.32.3", "172.30.33.2", "127.0.0.2", "192.0.2.10", "10.0.0.1", "::2", "1::ffff:ac1e:2002", "0.0.0.0", "::", undefined, "", "garbage"]) {
    assert.equal(isAllowedSource(bad), false, String(bad));
  }
});

async function request(port: number): Promise<"served" | "dropped"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    await res.text();
    return "served";
  } catch {
    return "dropped";
  }
}

test("attachGuard: loopback is served", async () => {
  const lines: string[] = [];
  const server = createServer((_q, s) => s.end("ok"));
  attachGuard(server, { allowAnySource: false, log: memLogger(lines) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    assert.equal(await request((server.address() as AddressInfo).port), "served");
  } finally {
    server.close();
  }
});

test("attachGuard: a non-allowed source is dropped, and logged once", async () => {
  const lines: string[] = [];
  const server = new EventEmitter() as unknown as Server;
  attachGuard(server, { allowAnySource: false, log: memLogger(lines) });
  // Simulate a connection from another container: emit with a fake socket.
  let destroyed = 0;
  const fake = { remoteAddress: "172.30.33.5", destroy: () => void destroyed++ };
  server.emit("connection", fake);
  server.emit("connection", fake);
  server.emit("connection", { remoteAddress: undefined, destroy: () => void destroyed++ });
  assert.equal(destroyed, 3);
  assert.equal(lines.filter((l) => l.includes("172.30.33.5")).length, 1);
  assert.equal(lines.filter((l) => l.includes("unknown")).length, 1);
});

test("attachGuard: HL_ALLOW_ANY_SOURCE disables the guard with a warning", () => {
  const lines: string[] = [];
  const server = new EventEmitter() as unknown as Server;
  attachGuard(server, { allowAnySource: true, log: memLogger(lines) });
  let destroyed = 0;
  server.emit("connection", { remoteAddress: "10.1.2.3", destroy: () => void destroyed++ });
  assert.equal(destroyed, 0);
  assert.ok(lines.some((l) => l.startsWith("warn ") && l.includes("guard is OFF")));
});

test("attachGuard: the guard runs before node:http's own connection listener", () => {
  const server = createServer();
  attachGuard(server, { allowAnySource: false, log: memLogger([]) });
  const first = server.listeners("connection")[0];
  assert.match(String(first), /isAllowedSource/);
});
