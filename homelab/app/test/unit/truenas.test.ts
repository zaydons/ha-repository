import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebSocket } from "ws";
import { truenas, versionOf, wsUrlFor } from "../../src/widgets/truenas.ts";
import { WidgetError } from "../../src/widgets/types.ts";
import type { WidgetConfig, WidgetNetPolicy } from "../../src/widgets/types.ts";
import { withRpcSession, rpcError } from "../../src/widgets/lib/ws-rpc.ts";
import { fixture, makeCtx, runPlugin, startFakeUpstream } from "../helpers/fake-upstream.ts";
import { makeSelfSigned, startFakeRpc, waitFor } from "../helpers/fake-ws.ts";
import type { RpcAnswer, RpcRequest } from "../helpers/fake-ws.ts";
import { createLogger, setLogLevel, setLogSecrets, setLogSink } from "../../src/log.ts";

const KEY = "FAKE-truenas-key-1-abcdefghijklmnop";
const USER = "FAKE-admin";
const PASS = "FAKE-truenas-password";
const INFO = fixture("truenas", "system-info");
const ALERTS = fixture("truenas", "alert-list");
const EXPECTED = { load: 0.53, uptime: 273906, alerts: 2 };

const CERT = makeSelfSigned();

// --- version 1 (REST) ---------------------------------------------------------

async function rest<T>(fn: (url: string, auth: () => (string | undefined)[], paths: () => string[]) => Promise<T>, info: unknown = INFO, alerts: unknown = ALERTS, status = 200) {
  const up = await startFakeUpstream({
    "GET /api/v2.0/system/info": { json: info, status },
    "GET /api/v2.0/alert/list": { json: alerts, status },
  });
  try {
    return await fn(
      up.url,
      () => up.requests.map((r) => r.headers.authorization),
      () => up.requests.map((r) => r.url),
    );
  } finally {
    await up.close();
  }
}

test("truenas v1: key -> Bearer; load (2 dp), uptime (s), non-dismissed alerts", async () => {
  await rest(async (url, auth, paths) => {
    const v = await runPlugin(truenas, { type: "truenas", url, key: KEY });
    assert.deepEqual(v, EXPECTED);
    assert.deepEqual(auth(), [`Bearer ${KEY}`, `Bearer ${KEY}`]);
    for (const p of paths()) assert.ok(!p.includes("?"), "no credentials in the query");
  });
});

test("truenas v1: username + password -> Basic", async () => {
  await rest(async (url, auth) => {
    await runPlugin(truenas, { type: "truenas", url, username: USER, password: PASS, version: 1 });
    const basic = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
    assert.deepEqual(auth(), [basic, basic]);
  });
});

test("truenas v1: fields drive which endpoints are called", async () => {
  await rest(async (url, _auth, paths) => {
    assert.deepEqual(await runPlugin(truenas, { type: "truenas", url, key: KEY }, ["alerts"]), { alerts: 2 });
    assert.deepEqual(paths(), ["/api/v2.0/alert/list"]);
  });
  await rest(async (url, _auth, paths) => {
    assert.deepEqual(await runPlugin(truenas, { type: "truenas", url, key: KEY }, ["uptime", "load"]), { uptime: 273906, load: 0.53 });
    assert.deepEqual(paths(), ["/api/v2.0/system/info"]);
  });
});

test("truenas v1: partial info -> nulls; errors map", async () => {
  await rest(async (url) => {
    assert.deepEqual(await runPlugin(truenas, { type: "truenas", url, key: KEY }), { load: null, uptime: null, alerts: 0 });
  }, fixture("truenas", "system-info-partial"), []);
  await rest(async (url) => {
    await assert.rejects(runPlugin(truenas, { type: "truenas", url, key: KEY }), { kind: "auth" });
  }, {}, [], 401);
  await rest(async (url) => {
    await assert.rejects(runPlugin(truenas, { type: "truenas", url, key: KEY }), { kind: "bad_response" });
  }, [1], {});
  await rest(async (url) => {
    await assert.rejects(runPlugin(truenas, { type: "truenas", url, key: KEY }), { kind: "bad_response" });
  }, {}, [], 302);
  const up = await startFakeUpstream({ "/api/v2.0/system/info": { json: INFO, delayMs: 1500 }, "/api/v2.0/alert/list": { json: ALERTS } });
  try {
    await assert.rejects(runPlugin(truenas, { type: "truenas", url: up.url, key: KEY }, undefined, { timeoutS: 0.3 }), {
      kind: "timeout",
    });
  } finally {
    await up.close();
  }
});

test("truenas: validate and version parsing", () => {
  const v = (cfg: Omit<WidgetConfig, "type">) => truenas.validate?.({ type: "truenas", url: "https://h", ...cfg });
  assert.equal(v({ key: KEY }), null);
  assert.equal(v({ username: USER, password: PASS }), null);
  assert.equal(v({}), "needs `key:` or `username:` and `password:`");
  assert.equal(v({ username: USER }), "needs `key:` or `username:` and `password:`");
  assert.equal(v({ key: KEY, version: 3 }), "`version:` must be 1 or 2");
  assert.equal(v({ key: KEY, version: "2" }), null);
  assert.equal(versionOf({ type: "truenas" }), 1);
  assert.equal(versionOf({ type: "truenas", version: 2 }), 2);
  assert.equal(versionOf({ type: "truenas", version: "x" }), null);
  for (const s of truenas.configKeys.secret) assert.ok([...truenas.configKeys.optional].includes(s));
  assert.ok(truenas.configKeys.optional.includes("enablePools"));
});

test("truenas: ws URL derivation (https -> wss, key forces wss, keeps sub-path)", () => {
  assert.equal(wsUrlFor("https://192.0.2.31", true).href, "wss://192.0.2.31/api/current");
  assert.equal(wsUrlFor("http://192.0.2.31", true).href, "wss://192.0.2.31/api/current");
  assert.equal(wsUrlFor("http://192.0.2.31:8080/nas/", false).href, "ws://192.0.2.31:8080/nas/api/current");
  assert.equal(wsUrlFor("https://192.0.2.31/?x=1#y", false).href, "wss://192.0.2.31/api/current");
  assert.throws(() => wsUrlFor("ftp://h", true), { kind: "config" });
  assert.throws(() => wsUrlFor(`https://u:${PASS}@h`, true), (e: WidgetError) => e.kind === "config" && !e.message.includes(PASS));
  assert.throws(() => wsUrlFor(undefined, true), { kind: "config" });
});

// --- version 2 (WebSocket JSON-RPC) -------------------------------------------

/** A TrueNAS-like handler with per-connection login state. */
function truenasHandler(over: Partial<Record<string, (req: RpcRequest) => RpcAnswer>> = {}) {
  const authed = new WeakSet<WebSocket>();
  return (req: RpcRequest, ws: WebSocket): RpcAnswer => {
    const custom = over[req.method];
    if (custom) {
      const a = custom(req);
      if (typeof a === "object" && "result" in a && a.result !== false) authed.add(ws);
      return a;
    }
    const params = req.params as unknown[];
    switch (req.method) {
      case "auth.login_with_api_key": {
        const ok = params[0] === KEY;
        if (ok) authed.add(ws);
        return { result: ok };
      }
      case "auth.login_ex": {
        const p = params[0] as Record<string, unknown>;
        const ok =
          (p.mechanism === "API_KEY_PLAIN" && p.username === USER && p.api_key === KEY) ||
          (p.mechanism === "PASSWORD_PLAIN" && p.username === USER && p.password === PASS);
        if (ok) authed.add(ws);
        return { result: { response_type: ok ? "SUCCESS" : "AUTH_ERR" } };
      }
      case "system.info":
      case "alert.list":
        if (!authed.has(ws)) return { error: { code: -32001, message: "Not authenticated", data: { errname: "ENOTAUTHENTICATED" } } };
        return { result: req.method === "system.info" ? INFO : ALERTS };
      default:
        return { error: { code: -32601, message: "Method does not exist" } };
    }
  };
}

function v2ctx(cfg: Omit<WidgetConfig, "type">, net?: Partial<WidgetNetPolicy>, fields = truenas.defaultFields, log = createLogger("truenas")) {
  const ctx = makeCtx({ type: "truenas", version: 2, ...cfg }, fields);
  ctx.log = log;
  if (net) ctx.net = { tlsVerify: false, timeoutS: 10, secrets: [], ...net };
  return ctx;
}

test("truenas v2: owner-like config (https + key) over wss with a self-signed cert", async (t) => {
  if (!CERT) return t.skip("openssl not available");
  const s = await startFakeRpc({ tls: CERT, handler: truenasHandler() });
  try {
    const ctx = v2ctx({ url: `https://${s.hostPort}`, key: KEY, enablePools: true, fields: ["load", "uptime", "alerts"] }, {});
    assert.deepEqual(await truenas.fetch(ctx), EXPECTED);
    assert.deepEqual(s.calls.map((c) => c.method), ["auth.login_with_api_key", "system.info", "alert.list"]);
    for (const c of s.calls) assert.equal((c as unknown as { jsonrpc: string }).jsonrpc, "2.0");
    assert.ok(await waitFor(() => s.closeCodes.length === 1), "socket closed");
    assert.deepEqual(s.closeCodes, [1000], "clean close");
  } finally {
    await s.close();
  }
});

test("truenas v2: an http url with a key is upgraded to wss (never sends the key over ws)", async (t) => {
  if (!CERT) return t.skip("openssl not available");
  const s = await startFakeRpc({ tls: CERT, handler: truenasHandler() });
  try {
    // Without ctx.net: exercises the fallback policy (tlsVerify off, 10 s).
    assert.deepEqual(await truenas.fetch(v2ctx({ url: `http://${s.hostPort}`, key: KEY })), EXPECTED);
  } finally {
    await s.close();
  }
  // Against a plain-ws server the TLS handshake fails: nothing readable was sent.
  const plain = await startFakeRpc({ handler: truenasHandler() });
  try {
    await assert.rejects(truenas.fetch(v2ctx({ url: `http://${plain.hostPort}`, key: KEY }, { timeoutS: 10 })), {
      kind: "unreachable",
    });
    assert.equal(plain.rawMessages.length, 0);
  } finally {
    await plain.close();
  }
});

test("truenas v2: username + password over plain ws uses auth.login_ex PASSWORD_PLAIN", async () => {
  const s = await startFakeRpc({ handler: truenasHandler() });
  try {
    const v = await truenas.fetch(v2ctx({ url: `http://${s.hostPort}`, username: USER, password: PASS }, {}, ["alerts"]));
    assert.deepEqual(v, { alerts: 2 });
    assert.deepEqual(s.calls.map((c) => c.method), ["auth.login_ex", "alert.list"]);
  } finally {
    await s.close();
  }
});

test("truenas v2: login fallbacks and refusals", async (t) => {
  if (!CERT) return t.skip("openssl not available");
  const run = async (handler: ReturnType<typeof truenasHandler>, cfg: Omit<WidgetConfig, "type">) => {
    const s = await startFakeRpc({ tls: CERT, handler });
    try {
      return { result: await truenas.fetch(v2ctx({ url: `https://${s.hostPort}`, ...cfg }, {})), calls: s.calls.map((c) => c.method) };
    } finally {
      await s.close();
    }
  };
  // key + username -> login_ex API_KEY_PLAIN (TrueNAS 27 path)
  const a = await run(truenasHandler(), { key: KEY, username: USER });
  assert.deepEqual(a.result, EXPECTED);
  assert.equal(a.calls[0], "auth.login_ex");
  // login_ex missing (older build) -> auth.login
  const b = await run(
    truenasHandler({
      "auth.login_ex": () => ({ error: { code: -32601, message: "Method does not exist" } }),
      "auth.login": (r) => ({ result: (r.params as unknown[])[0] === USER && (r.params as unknown[])[1] === PASS }),
    }),
    { username: USER, password: PASS },
  );
  assert.deepEqual(b.calls.slice(0, 2), ["auth.login_ex", "auth.login"]);
  // wrong key -> auth; wrong password -> auth; OTP -> auth
  await assert.rejects(run(truenasHandler(), { key: "FAKE-wrong-key" }), { kind: "auth" });
  await assert.rejects(run(truenasHandler(), { username: USER, password: "FAKE-wrong" }), { kind: "auth" });
  await assert.rejects(
    run(truenasHandler({ "auth.login_ex": () => ({ result: { response_type: "OTP_REQUIRED", username: USER } }) }), { username: USER, password: PASS }),
    (e: WidgetError) => e.kind === "auth" && /one-time/.test(e.message),
  );
  // login_with_api_key removed (TrueNAS 27) and no username -> config hint
  await assert.rejects(
    run(truenasHandler({ "auth.login_with_api_key": () => ({ error: { code: -32601, message: "Method does not exist" } }) }), { key: KEY }),
    (e: WidgetError) => e.kind === "config" && /username/.test(e.message),
  );
  // permission error on a data call -> auth
  await assert.rejects(
    run(truenasHandler({ "alert.list": () => ({ error: { code: -32001, message: "x", data: { errname: "EACCES", reason: "Permission denied" } } }) }), { key: KEY }),
    { kind: "auth" },
  );
  // missing loadavg -> null, not an error
  const c = await run(truenasHandler({ "system.info": () => ({ result: fixture("truenas", "system-info-partial") }) }), { key: KEY });
  assert.deepEqual(c.result, { load: null, uptime: null, alerts: 2 });
});

test("truenas v2: TLS policy follows ctx.net (verify on rejects self-signed; ca.pem accepts it)", async (t) => {
  if (!CERT) return t.skip("openssl not available");
  const s = await startFakeRpc({ tls: CERT, handler: truenasHandler() });
  try {
    const url = `https://${s.hostPort}`;
    await assert.rejects(truenas.fetch(v2ctx({ url, key: KEY }, { tlsVerify: true })), (e: WidgetError) => {
      return e.kind === "unreachable" && typeof e.detail === "string" && e.detail.length > 0;
    });
    assert.equal(s.rawMessages.length, 0, "no credentials sent before verification");
    assert.deepEqual(await truenas.fetch(v2ctx({ url, key: KEY }, { tlsVerify: true, ca: CERT.cert })), EXPECTED);
  } finally {
    await s.close();
  }
});

test("truenas v2: timeout, abort, garbage, oversize, upgrade refusals, refused port, server close", async (t) => {
  if (!CERT) return t.skip("openssl not available");
  // Server never answers system.info: the session deadline fires and the socket is torn down.
  // Event-driven, no wall clock: each phase waits until the server has the system.info call.
  let infoSeen: () => void = () => {};
  const nextInfo = () => new Promise<void>((r) => (infoSeen = r));
  const silent = await startFakeRpc({
    tls: CERT,
    handler: truenasHandler({
      "system.info": () => {
        infoSeen();
        return "silent";
      },
    }),
  });
  try {
    // The session deadline runs on a mocked clock, so a slow TLS handshake on a loaded host can't
    // trip it early (the real handshake idle timeout is the same 5 s). It must fire exactly at timeoutS.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let seen = nextInfo();
    const outcome = truenas
      .fetch(v2ctx({ url: `https://${silent.hostPort}`, key: KEY }, { timeoutS: 5 }))
      .then(() => "resolved", (e: unknown) => e);
    await Promise.race([seen, outcome]);
    let settled = false;
    void outcome.then(() => (settled = true));
    t.mock.timers.tick(4999);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "no timeout before the session deadline");
    t.mock.timers.tick(1);
    const err = await outcome;
    assert.ok(err instanceof WidgetError, String(err));
    assert.equal(err.kind, "timeout");
    assert.equal(err.message, "Timed out after 5 s", "the session deadline fired");
    t.mock.timers.reset();
    assert.ok(await waitFor(() => silent.closeCodes.length === 1), "server saw the socket close");
    // Abort via ctx.signal, once the session is waiting on system.info.
    const ac = new AbortController();
    const ctx = v2ctx({ url: `https://${silent.hostPort}`, key: KEY }, { timeoutS: 30 });
    ctx.signal = ac.signal;
    seen = nextInfo();
    const aborted = truenas.fetch(ctx);
    await Promise.race([seen, aborted.catch(() => {})]);
    ac.abort();
    await assert.rejects(aborted, (e: WidgetError) => e.kind === "timeout" && /cancel/i.test(e.message));
  } finally {
    t.mock.timers.reset();
    await silent.close();
  }

  const garbage = await startFakeRpc({ tls: CERT, handler: () => ({ raw: "<html>nope" }) });
  try {
    await assert.rejects(truenas.fetch(v2ctx({ url: `https://${garbage.hostPort}`, key: KEY }, {})), { kind: "bad_response" });
  } finally {
    await garbage.close();
  }

  // Notifications (no id) are ignored.
  const noisy = await startFakeRpc({
    tls: CERT,
    onConnect: (ws) => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "collection_update", params: { msg: "added" } })),
    handler: truenasHandler(),
  });
  try {
    assert.deepEqual(await truenas.fetch(v2ctx({ url: `https://${noisy.hostPort}`, key: KEY }, {})), EXPECTED);
  } finally {
    await noisy.close();
  }

  for (const [status, kind, headers] of [
    [401, "auth", {}],
    [403, "auth", {}],
    [404, "bad_response", {}],
    [302, "bad_response", { location: "https://example.invalid/api/current" }],
  ] as const) {
    const s = await startFakeRpc({ tls: CERT, rejectUpgrade: { status, headers }, handler: truenasHandler() });
    try {
      await assert.rejects(truenas.fetch(v2ctx({ url: `https://${s.hostPort}`, key: KEY }, {})), (e: WidgetError) => {
        return e.kind === kind && e.httpStatus === status;
      });
      assert.equal(s.upgrades, 1, "redirect not followed");
    } finally {
      await s.close();
    }
  }

  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  await assert.rejects(truenas.fetch(v2ctx({ url: `https://127.0.0.1:${port}`, key: KEY }, {})), { kind: "unreachable" });

  const closer = await startFakeRpc({
    tls: CERT,
    handler: (req, ws) => {
      if (req.method === "system.info") {
        ws.close(1011);
        return "silent";
      }
      return truenasHandler()(req, ws);
    },
  });
  try {
    await assert.rejects(truenas.fetch(v2ctx({ url: `https://${closer.hostPort}`, key: KEY }, {})), { kind: "unreachable" });
  } finally {
    await closer.close();
  }
});

test("ws-rpc: messages over the size cap are bad_response and the session is torn down", async () => {
  const s = await startFakeRpc({ handler: () => ({ result: "x".repeat(4096) }) });
  try {
    await assert.rejects(
      withRpcSession(
        { url: new URL(`ws://${s.hostPort}/api/current`), tlsVerify: false, timeoutS: 10, maxMessageBytes: 1024 },
        (r) => r.call("big"),
      ),
      (e: WidgetError) => e.kind === "bad_response" && /larger/.test(e.message),
    );
    assert.ok(await waitFor(() => s.closeCodes.length === 1));
  } finally {
    await s.close();
  }
  await assert.rejects(
    withRpcSession({ url: new URL("http://127.0.0.1/"), tlsVerify: false, timeoutS: 1 }, async () => 1),
    { kind: "config" },
  );
});

test("ws-rpc: rpcError maps auth errnames and redacts reasons", () => {
  const e = rpcError("auth.x", { code: -32001, message: "m", data: { errname: "EACCES", reason: `bad key ${KEY}\n` } }, [KEY]);
  assert.equal(e.kind, "auth");
  assert.ok(!e.message.includes(KEY) && !e.message.includes("\n"));
  assert.equal(rpcError("x", { code: -32601, message: "Method does not exist" }).rpcCode, -32601);
  assert.equal(rpcError("x", "junk").kind, "bad_response");
});

test("truenas v2: credentials never reach a log line or an error, on any path", async (t) => {
  if (!CERT) return t.skip("openssl not available");
  const lines: string[] = [];
  const errors: string[] = [];
  setLogLevel("debug");
  setLogSecrets([]); // no global safety net
  setLogSink((_l, line) => lines.push(line));
  try {
    const echo = (r: RpcRequest): RpcAnswer => ({ error: { code: -32001, message: JSON.stringify(r.params), data: { reason: `rejected ${JSON.stringify(r.params)}` } } });
    const handlers = [
      truenasHandler(),
      truenasHandler({ "auth.login_with_api_key": echo, "auth.login_ex": echo }),
      truenasHandler({ "system.info": () => ({ raw: `not json ${KEY}` }) }),
      truenasHandler({ "system.info": () => "silent" }),
    ];
    const silentHandler = handlers[3];
    for (const handler of handlers) {
      for (const cfg of [{ key: KEY }, { username: USER, password: PASS }, { key: KEY, username: USER }]) {
        const s = await startFakeRpc({ tls: CERT, handler });
        try {
          await truenas.fetch(v2ctx({ url: `https://${s.hostPort}`, ...cfg }, { timeoutS: handler === silentHandler ? 0.4 : 10 }));
        } catch (err) {
          assert.ok(err instanceof WidgetError);
          errors.push(`${err.kind} ${err.message} ${err.detail ?? ""}`);
        } finally {
          await s.close();
        }
      }
    }
  } finally {
    setLogSink(null);
    setLogLevel("info");
  }
  assert.ok(lines.length > 0 && errors.length >= 6);
  for (const s of [...lines, ...errors]) {
    for (const secret of [KEY, USER, PASS]) assert.ok(!s.includes(secret), `leaked ${secret}: ${s}`);
  }
});
