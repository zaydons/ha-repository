// Test helper: the common error-path cases every media plugin must map the same
// way (design §9 "each plugin against fixtures"). Defines no tests itself.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { makeCtx, startFakeUpstream } from "./fake-upstream.ts";
import { WidgetError } from "../../src/widgets/types.ts";
import type { WidgetConfig, WidgetPlugin } from "../../src/widgets/types.ts";

export async function expectWidgetError(p: Promise<unknown>, kind: string, secret?: string): Promise<WidgetError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof WidgetError, `expected WidgetError, got ${String(err)}`);
    assert.equal(err.kind, kind, err.message);
    if (secret) assert.ok(!err.message.includes(secret), "error message leaks the secret");
    return err;
  }
  assert.fail(`expected a ${kind} error`);
}

/**
 * Runs `plugin` against an upstream that answers every path the same way and
 * checks the mapped error kind: 401 -> auth, 500 -> bad_response,
 * garbage -> bad_response, 302 -> bad_response, slow -> timeout,
 * closed port -> unreachable.
 */
export async function checkCommonErrors(plugin: WidgetPlugin, cfg: Omit<WidgetConfig, "url">, secret: string): Promise<void> {
  const cases: { name: string; respond: (res: http.ServerResponse) => void; kind: string }[] = [
    { name: "401", kind: "auth", respond: (res) => res.writeHead(401).end("Unauthorized") },
    { name: "500", kind: "bad_response", respond: (res) => res.writeHead(500).end("boom") },
    {
      name: "garbage",
      kind: "bad_response",
      respond: (res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>login</html>"),
    },
    {
      name: "wrong shape",
      kind: "bad_response",
      respond: (res) => res.writeHead(200, { "content-type": "application/json" }).end("42"),
    },
    {
      name: "redirect",
      kind: "bad_response",
      respond: (res) => res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end(),
    },
    { name: "slow", kind: "timeout", respond: (res) => setTimeout(() => res.destroyed || res.end("{}"), 1000) },
  ];
  for (const c of cases) {
    const up = await startFakeUpstreamAll(c.respond);
    try {
      const ctx = makeCtx({ ...cfg, url: up.url } as WidgetConfig, plugin.defaultFields, { timeoutS: 0.3 });
      await expectWidgetError(plugin.fetch(ctx), c.kind, secret).catch((err: unknown) => {
        throw new Error(`${plugin.type} / ${c.name}: ${(err as Error).message}`);
      });
    } finally {
      await up.close();
    }
  }
  // Nothing listening.
  const gone = await startFakeUpstream({});
  const url = gone.url;
  await gone.close();
  await expectWidgetError(plugin.fetch(makeCtx({ ...cfg, url } as WidgetConfig, plugin.defaultFields)), "unreachable", secret);
}

/** An upstream that answers every request with `respond`. */
async function startFakeUpstreamAll(
  respond: (res: http.ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => respond(res));
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
