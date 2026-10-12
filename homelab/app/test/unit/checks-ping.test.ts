import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkPing, parsePingTarget, pingArgs } from "../../src/checks/ping.ts";
import type { ExecFn, ExecResult } from "../../src/checks/ping.ts";

function fakeExec(result: Partial<ExecResult>, calls: { file: string; args: string[] }[] = []): ExecFn {
  return async (file, args) => {
    calls.push({ file, args });
    return { exitCode: 0, killed: false, stdout: "", stderr: "", ...result };
  };
}

test("parsePingTarget: accepts hostnames, IPv4, IPv6 and http(s) URLs", () => {
  assert.deepEqual(parsePingTarget("192.168.1.20"), { host: "192.168.1.20", ipv6: false });
  assert.deepEqual(parsePingTarget(" nas.lan "), { host: "nas.lan", ipv6: false });
  assert.deepEqual(parsePingTarget("truenas"), { host: "truenas", ipv6: false });
  assert.deepEqual(parsePingTarget("fd00::1"), { host: "fd00::1", ipv6: true });
  assert.deepEqual(parsePingTarget("[fd00::1]"), { host: "fd00::1", ipv6: true });
  assert.deepEqual(parsePingTarget("http://192.168.1.20:8096/web"), { host: "192.168.1.20", ipv6: false });
  assert.deepEqual(parsePingTarget("https://[fd00::2]:443/"), { host: "fd00::2", ipv6: true });
});

test("parsePingTarget: rejects option-like, malformed and non-string values", () => {
  for (const bad of ["-f", "-c 100 host", "--help", "", "  ", "host name", "a;rm -rf /", "$(id)", "host`id`", "999.1.1.1", "1.2.3", "x".repeat(254), "-1.2.3.4", "ftp://host"]) {
    assert.equal(parsePingTarget(bad), null, bad);
  }
  for (const bad of [undefined, null, 42, {}, ["host"]]) assert.equal(parsePingTarget(bad), null);
});

test("pingArgs: one probe, 2 s wait, numeric, -6 for IPv6, host last", () => {
  assert.deepEqual(pingArgs({ host: "10.0.0.1", ipv6: false }), ["-c", "1", "-W", "2", "-n", "10.0.0.1"]);
  assert.deepEqual(pingArgs({ host: "fd00::1", ipv6: true }), ["-c", "1", "-W", "2", "-n", "-6", "fd00::1"]);
});

test("ping: exit 0 is up with latency from time=", async () => {
  const calls: { file: string; args: string[] }[] = [];
  const out = "PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.\n64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=3.42 ms\n";
  const r = await checkPing("10.0.0.1", { exec: fakeExec({ stdout: out }, calls) });
  assert.deepEqual(r, { state: "up", kind: "ping", host: "10.0.0.1", latencyMs: 3 });
  assert.equal(calls[0]?.file, "ping");
  assert.deepEqual(calls[0]?.args, ["-c", "1", "-W", "2", "-n", "10.0.0.1"]);
});

test("ping: up without a parsable time has no latency", async () => {
  const r = await checkPing("10.0.0.1", { exec: fakeExec({ stdout: "1 packets received" }) });
  assert.equal(r.state, "up");
  assert.equal(r.latencyMs, undefined);
});

test("ping: no reply is down with reason ping", async () => {
  const r = await checkPing("10.0.0.9", { exec: fakeExec({ exitCode: 1, stdout: "1 packets transmitted, 0 received, 100% packet loss" }) });
  assert.deepEqual(r, { state: "down", kind: "ping", reason: "ping", host: "10.0.0.9" });
});

test("ping: unresolvable name is down with reason dns (iputils and busybox wording)", async () => {
  for (const stderr of ["ping: nope.lan: Name or service not known", "ping: bad address 'nope.lan'", "ping: unknown host nope.lan", "ping: nope.lan: Name does not resolve"]) {
    const r = await checkPing("nope.lan", { exec: fakeExec({ exitCode: 2, stderr }) });
    assert.equal(r.state, "down", stderr);
    assert.equal(r.reason, "dns", stderr);
  }
});

test("ping: killed by the timeout is down with reason timeout", async () => {
  const r = await checkPing("10.0.0.9", { exec: fakeExec({ exitCode: null, killed: true }) });
  assert.equal(r.state, "down");
  assert.equal(r.reason, "timeout");
});

test("ping: missing binary or no permission is unknown/check_failed", async () => {
  for (const spawnError of ["ENOENT", "EACCES", "EPERM"]) {
    const r = await checkPing("10.0.0.1", { exec: fakeExec({ exitCode: null, spawnError }) });
    assert.equal(r.state, "unknown");
    assert.equal(r.reason, "check_failed");
    assert.equal(r.detail, spawnError);
  }
  const perm = await checkPing("10.0.0.1", { exec: fakeExec({ exitCode: 2, stderr: "ping: socket: Operation not permitted" }) });
  assert.equal(perm.state, "unknown");
  assert.equal(perm.detail, "icmp_not_permitted");
});

test("ping: invalid host never runs the binary", async () => {
  const calls: { file: string; args: string[] }[] = [];
  const r = await checkPing("-f", { exec: fakeExec({}, calls) });
  assert.equal(r.state, "unknown");
  assert.equal(r.detail, "invalid_host");
  assert.equal(calls.length, 0);
});

test("ping: exec that throws is reported, not thrown", async () => {
  const r = await checkPing("10.0.0.1", {
    exec: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(r.state, "unknown");
  assert.equal(r.detail, "exec_failed");
});

test("ping: the default exec reports a missing binary as ENOENT", async () => {
  const r = await checkPing("127.0.0.1", { binary: "/nonexistent/ping-binary" });
  assert.equal(r.state, "unknown");
  assert.equal(r.detail, "ENOENT");
});

function hasPing(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v ping"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("ping: live loopback with the real binary and this (non-root) user", { skip: !hasPing() && "no ping binary" }, async () => {
  const r = await checkPing("127.0.0.1");
  assert.equal(r.state, "up", JSON.stringify(r));
  assert.equal(r.kind, "ping");
});
