// Test helper: a fake JSON-RPC 2.0 WebSocket server (TrueNAS-like) at
// /api/current, over ws or wss, plus a self-signed cert generator.
// (node --test also loads this file; it defines no tests.)
import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

/** Return {result}, {error}, "silent" (never answer), or a raw string to send. */
export type RpcAnswer = { result: unknown } | { error: unknown } | "silent" | { raw: string | Buffer };

export interface FakeRpcServer {
  /** e.g. "127.0.0.1:54321" */
  hostPort: string;
  /** Every request received, in order. */
  calls: RpcRequest[];
  /** Close codes the server observed per connection (1006 = no close frame). */
  closeCodes: number[];
  /** Number of upgrade requests seen. */
  upgrades: number;
  /** Raw text of every message received (for leak checks). */
  rawMessages: string[];
  close(): Promise<void>;
}

export interface FakeRpcOptions {
  tls?: { key: string; cert: string };
  /** Answer an HTTP status instead of upgrading. */
  rejectUpgrade?: { status: number; headers?: Record<string, string> };
  /** Sent to every new connection before anything else. */
  onConnect?: (ws: WebSocket) => void;
  handler: (req: RpcRequest, ws: WebSocket) => RpcAnswer;
}

export async function startFakeRpc(opts: FakeRpcOptions): Promise<FakeRpcServer> {
  const calls: RpcRequest[] = [];
  const closeCodes: number[] = [];
  const rawMessages: string[] = [];
  let upgrades = 0;
  const server = opts.tls ? https.createServer(opts.tls) : http.createServer();
  server.on("request", (_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgrades++;
    if (opts.rejectUpgrade) {
      const h = Object.entries(opts.rejectUpgrade.headers ?? {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.end(`HTTP/1.1 ${opts.rejectUpgrade.status} X\r\n${h}content-length: 0\r\nconnection: close\r\n\r\n`);
      return;
    }
    if ((req.url ?? "").split("?")[0] !== "/api/current") {
      socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("close", (code) => closeCodes.push(code));
      opts.onConnect?.(ws);
      ws.on("message", (data) => {
        const text = data.toString();
        rawMessages.push(text);
        const msg = JSON.parse(text) as RpcRequest;
        calls.push(msg);
        const a = opts.handler(msg, ws);
        if (a === "silent") return;
        if ("raw" in a) ws.send(a.raw);
        else ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...a }));
      });
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    hostPort: `127.0.0.1:${port}`,
    calls,
    closeCodes,
    rawMessages,
    get upgrades() {
      return upgrades;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        for (const s of sockets) s.destroy();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

/** A throwaway self-signed cert for 127.0.0.1 (generated at test time; nothing committed). */
export function makeSelfSigned(): { key: string; cert: string } | null {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-ws-tls-"));
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
    return { key: readFileSync(path.join(dir, "key.pem"), "utf8"), cert: readFileSync(path.join(dir, "cert.pem"), "utf8") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Waits until `pred` holds or `ms` passes. */
export async function waitFor(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}
