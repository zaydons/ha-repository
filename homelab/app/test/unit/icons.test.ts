import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createIconService, NEGATIVE_FAILURE_MS, NEGATIVE_NOT_FOUND_MS } from "../../src/iconsvc/index.ts";
import type { IconServiceOptions } from "../../src/iconsvc/index.ts";
import { cdnFile, cdnUrl, contentTypeFor, letterFor, parseCdnFile, parseIcon } from "../../src/iconsvc/resolve.ts";
import { colourSvg, isSafeSvg, matchesType } from "../../src/iconsvc/svg.ts";
import { fetchIcon, MAX_ICON_BYTES } from "../../src/iconsvc/cdn.ts";
import type { FetchFn } from "../../src/iconsvc/cdn.ts";
import { buildHttpServer } from "../../src/server.ts";
import { createStubConfigService, createStubStateService } from "../../src/http/stubs.ts";
import { ICON_CSP } from "../../src/http/respond.ts";
import type { BootContext, Logger } from "../../src/types.ts";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>');

const OWNER_CDN = [
  "plex.png", "jellyfin.png", "immich.png", "audiobookshelf.png", "sonarr.png", "radarr.png",
  "lidarr.png", "prowlarr.png", "sabnzbd.png", "filebrowser.png", "truenas.png", "cloudflare.png",
];
const OWNER_MDI = ["mdi-contacts", "mdi-safe", "mdi-server"];

interface Captured { lines: string[]; log: Logger }
function capture(): Captured {
  const lines: string[] = [];
  const mk = (): Logger => ({
    debug: (m) => lines.push(`D ${m}`),
    info: (m) => lines.push(`I ${m}`),
    warn: (m) => lines.push(`W ${m}`),
    error: (m) => lines.push(`E ${m}`),
    child: () => mk(),
  });
  return { lines, log: mk() };
}

interface FakeCdn { fetch: FetchFn; calls: string[]; online: boolean; responder: (url: string) => Response }
function fakeCdn(): FakeCdn {
  const f: FakeCdn = {
    calls: [],
    online: true,
    responder: (url) => {
      if (url.includes("/png/")) return new Response(new Uint8Array(PNG), { status: 200, headers: { "content-type": "image/png" } });
      if (url.includes("/svg/")) return new Response(new Uint8Array(SVG), { status: 200, headers: { "content-type": "image/svg+xml" } });
      return new Response("nope", { status: 404 });
    },
    fetch: async (url, init) => {
      f.calls.push(url);
      assert.equal(init.redirect, "manual");
      if (!f.online) throw new TypeError("fetch failed");
      return f.responder(url);
    },
  };
  return f;
}

let root = "";
let configDir = "";
let dataDir = "";
let clock = 0;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hl-icons-"));
  configDir = join(root, "config");
  dataDir = join(root, "data");
  await mkdir(join(configDir, "custom-icons"), { recursive: true });
  await mkdir(join(dataDir, "icon-cache"), { recursive: true });
  clock = Date.parse("2026-10-12T12:00:00Z");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service(cdn: FakeCdn, log: Logger = capture().log, extra: IconServiceOptions = {}) {
  const ctx: BootContext = {
    options: { log_level: "info" },
    paths: { configDir, dataDir, sampleDir: join(APP, "sample"), webDir: join(APP, "web") },
    configPathDisplay: "/addon_configs/abcd1234_homelab/",
    log,
  };
  return createIconService(ctx, { fetch: cdn.fetch, now: () => clock, ...extra });
}
const q = (s = "") => new URLSearchParams(s);

describe("icons: parsing", () => {
  test("Homepage forms", () => {
    assert.deepEqual(parseIcon("mdi-server"), { kind: "pack", set: "mdi", name: "server" });
    assert.deepEqual(parseIcon("mdi-home-assistant-#F0D453"), { kind: "pack", set: "mdi", name: "home-assistant", colour: "f0d453" });
    assert.deepEqual(parseIcon("si-jellyfin"), { kind: "pack", set: "si", name: "jellyfin" });
    assert.deepEqual(parseIcon("si-uniqlo_ja-#000000"), { kind: "pack", set: "si", name: "uniqlo_ja", colour: "000000" });
    assert.deepEqual(parseIcon("plex.png"), { kind: "cdn", set: "di", file: "plex.png", localFirst: true });
    assert.deepEqual(parseIcon("plex"), { kind: "cdn", set: "di", file: "plex.png", localFirst: true });
    assert.deepEqual(parseIcon("Home-Assistant.SVG"), { kind: "cdn", set: "di", file: "home-assistant.svg", localFirst: true });
    assert.deepEqual(parseIcon("sh-jellyfin.webp"), { kind: "cdn", set: "sh", file: "jellyfin.webp", localFirst: false });
    assert.deepEqual(parseIcon("/icons/my-nas.png"), { kind: "local", file: "my-nas.png" });
    assert.deepEqual(parseIcon("https://example.com/a.png"), { kind: "url", src: "https://example.com/a.png" });
  });

  test("URL icons lose userinfo; non-http schemes are invalid", () => {
    assert.deepEqual(parseIcon("https://user:pa55@example.com/a.png"), { kind: "url", src: "https://example.com/a.png" });
    for (const bad of ["javascript:alert(1)", "data:image/svg+xml,<svg onload=alert(1)>", "file:///etc/passwd", "//evil.example/x.png"]) {
      assert.equal(parseIcon(bad).kind, "invalid", bad);
    }
  });

  test("traversal and junk names are invalid", () => {
    for (const bad of [
      "", "   ", "../etc/passwd", "plex.png/../../x", "/icons/../secrets.yaml", "/icons/sub/x.png", "/icons/.hidden.png",
      "/icons/x.yaml", "mdi-../../x", "mdi-", "si-a/b", "a%2f..", "x".repeat(300), "-plex", ".plex", "plex..png",
      "plex.png\u0000", "pl ex",
    ]) {
      assert.equal(parseIcon(bad).kind, "invalid", JSON.stringify(bad));
    }
  });

  test("cdn names and fixed URL templates", () => {
    assert.equal(cdnFile("plex"), "plex.png");
    assert.equal(cdnFile("a.b"), "a.b.png");
    assert.equal(cdnFile("a."), null);
    assert.deepEqual(parseCdnFile("plex.svg"), { base: "plex", ext: "svg" });
    assert.equal(parseCdnFile("plex"), null);
    assert.equal(parseCdnFile("../plex.png"), null);
    assert.equal(cdnUrl("di", "plex.png"), "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/plex.png");
    assert.equal(cdnUrl("sh", "jellyfin.webp"), "https://cdn.jsdelivr.net/gh/selfhst/icons/webp/jellyfin.webp");
    assert.throws(() => cdnUrl("di", "../x.png"));
  });

  test("letter fallback and content-type allowlist", () => {
    assert.equal(letterFor("  plex"), "P");
    assert.equal(letterFor(""), undefined);
    assert.equal(letterFor("\u{1F600} smile"), "\u{1F600}");
    assert.equal(contentTypeFor("a.png"), "image/png");
    assert.equal(contentTypeFor("a.svg"), "image/svg+xml");
    assert.equal(contentTypeFor("a.webp"), "image/webp");
    for (const f of ["a.html", "a.js", "a.jpg", "a.constructor", "a.toString", "a"]) assert.equal(contentTypeFor(f), null, f);
  });
});

describe("icons: svg and type checks", () => {
  test("safe SVGs pass; active content and external refs are rejected", () => {
    assert.equal(isSafeSvg(SVG), true);
    assert.equal(isSafeSvg(Buffer.from('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>')), true);
    assert.equal(isSafeSvg(Buffer.from('<svg><image href="data:image/png;base64,AAAA"/></svg>')), true);
    for (const bad of [
      "<svg><script>alert(1)</script></svg>",
      '<svg onload="alert(1)"></svg>',
      "<svg><foreignObject><div/></foreignObject></svg>",
      '<svg><a href="javascript:alert(1)">x</a></svg>',
      '<svg><image href="https://tracker.example/p.png"/></svg>',
      '<svg><use xlink:href="other.svg#a"/></svg>',
      '<svg><image href="data:image/svg+xml;base64,AAAA"/></svg>',
      '<svg><rect style="fill:url(https://x.example/a)"/></svg>',
      "<svg><style>@import 'x.css';</style></svg>",
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
      "Couldn't find the requested file",
    ]) {
      assert.equal(isSafeSvg(Buffer.from(bad)), false, bad);
    }
  });

  test("V1: namespaced elements, attributes and links are rejected", () => {
    const bypasses = [
      // Prefixed active elements (the devsecops sample, and variants).
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(document.domain)</s:script></svg>',
      '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script\n>alert(1)</s:script></svg>',
      '<svg><S:SCRIPT>alert(1)</S:SCRIPT></svg>',
      '<svg xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></svg>',
      '<svg><a.b-c:script/></svg>',
      '<svg><\u00e9:script>alert(1)</\u00e9:script></svg>',
      '<svg><svg:foreignObject><body/></svg:foreignObject></svg>',
      '<svg><x:iframe src="#"/></svg>',
      '<svg><x:embed/></svg>',
      '<svg><x:object/></svg>',
      '<svg><ev:listener event="load" handler="#h"/><ev:handler id="h">alert(1)</ev:handler></svg>',
      // Event-handler attributes, plain and prefixed.
      '<svg x:onload="alert(1)"></svg>',
      '<svg><rect s:onclick = "alert(1)"/></svg>',
      '<svg><rect id="a"onmouseover="alert(1)"/></svg>',
      '<svg><rect\tONLOAD="alert(1)"/></svg>',
      '<svg><animate onbegin="alert(1)" attributeName="x"/></svg>',
      // Links to anything other than the same document.
      '<svg><use x:href="other.svg#a"/></svg>',
      '<svg><use xlink:href = "https://evil.example/a.svg#x"/></svg>',
      "<svg><image href='https://tracker.example/p.png'/></svg>",
      '<svg><a href="&#x6a;avascript:alert(1)"><rect/></a></svg>',
      '<svg><image href=https://evil.example/x.png /></svg>',
      '<svg><a xlink:href="data:text/html,<script>alert(1)</script>"/></svg>',
      '<svg><rect fill="url( \'https://x.example/a\' )"/></svg>',
      '<svg><set attributeName="xlink:href" to="https://evil.example/"/></svg>',
      '<svg><animate attributeName="href" values="#a;https://evil.example/"/></svg>',
      // XHTML content and processing instructions.
      '<svg><div xmlns="http://www.w3.org/1999/xhtml">x</div></svg>',
      '<?xml-stylesheet href="x.xsl" type="text/xsl"?><svg/>',
      '<!DOCTYPE svg [<!ATTLIST svg onload CDATA "alert(1)">]><svg></svg>',
    ];
    for (const bad of bypasses) assert.equal(isSafeSvg(Buffer.from(bad)), false, bad);
  });

  test("V1: legitimate SVG constructs still pass", () => {
    for (const good of [
      '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>',
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><defs><circle id="a"/></defs><clipPath id="b"><use xlink:href="#a" style="overflow:visible"/></clipPath></svg>',
      "<svg><use xlink:href = '#a'/><rect fill='url(\"#g\")'/></svg>",
      '<svg><image xlink:href="data:image/png;base64,AAAA"/></svg>',
      '<svg><animate attributeName="opacity" values="0;1"/><g opacity=".5" offset="1"/></svg>',
      '<svg><scripts-not-a-tag/><objects/></svg>',
    ]) {
      assert.equal(isSafeSvg(Buffer.from(good)), true, good);
    }
  });

  test("magic bytes must match the extension", () => {
    assert.equal(matchesType(PNG, "image/png"), true);
    assert.equal(matchesType(WEBP, "image/webp"), true);
    assert.equal(matchesType(Buffer.from("<html>"), "image/png"), false);
    assert.equal(matchesType(PNG, "image/webp"), false);
    assert.equal(matchesType(PNG, "text/html"), false);
  });

  test("colourSvg sets a fill on the root element only for valid colours", () => {
    assert.match(colourSvg(SVG, "ff0000").toString(), /^<svg fill="#ff0000" xmlns/);
    assert.equal(colourSvg(SVG, '"><script>').toString(), SVG.toString());
  });
});

describe("icons: CDN fetch", () => {
  const ok = (body: Uint8Array | string, ct: string, status = 200, headers: Record<string, string> = {}) =>
    async () => new Response(body, { status, headers: { "content-type": ct, ...headers } });

  test("accepts a matching image and takes the type from the extension", async () => {
    const r = await fetchIcon(ok(new Uint8Array(PNG), "image/png; charset=binary"), "https://x/png/a.png", "a.png");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.contentType, "image/png");
    const s = await fetchIcon(ok(new Uint8Array(SVG), "image/svg+xml"), "https://x/svg/a.svg", "a.svg");
    assert.equal(s.ok && s.contentType, "image/svg+xml");
  });

  test("failures map to notFound (long) or transient (short)", async () => {
    const cases: Array<[FetchFn, boolean, string]> = [
      [ok("x", "text/plain", 404), true, "HTTP 404"],
      [ok("x", "text/plain", 500), false, "HTTP 500"],
      [async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), false, "HTTP 302"],
      [ok("<html>", "text/html"), false, "not an image"],
      [ok(new Uint8Array(PNG), "image/png", 200, { "content-length": String(MAX_ICON_BYTES + 1) }), false, "too large"],
      [ok(new Uint8Array(MAX_ICON_BYTES + 10), "image/png"), false, "too large"],
      [ok("<html>", "image/png"), true, "content rejected"],
      [ok("<svg onload=alert(1)>", "image/svg+xml"), true, "content rejected"],
      [async () => { throw new TypeError("fetch failed"); }, false, "network error"],
      [async () => { throw new DOMException("t", "TimeoutError"); }, false, "timeout"],
    ];
    for (const [fn, notFound, reason] of cases) {
      const r = await fetchIcon(fn, "https://x/png/a.png", "a.png");
      assert.equal(r.ok, false, reason);
      if (!r.ok) {
        assert.equal(r.notFound, notFound, reason);
        assert.equal(r.reason, reason);
      }
    }
  });

  test("unsafe svg from the CDN is rejected", async () => {
    const r = await fetchIcon(ok("<svg onload=alert(1)>", "image/svg+xml"), "https://x/svg/a.svg", "a.svg");
    assert.deepEqual(r, { ok: false, notFound: true, reason: "content rejected" });
  });
});

describe("icons: service", () => {
  test("every owner icon resolves (AC: owner config)", async () => {
    const cdn = fakeCdn();
    const svc = service(cdn);
    for (const i of OWNER_MDI) {
      const ref = svc.resolve(i, "Svc");
      assert.deepEqual(ref, { kind: "proxied", src: `icons/mdi/${i.slice(4)}.svg` });
      const res = await svc.get("mdi", `${i.slice(4)}.svg`, q());
      assert.ok(res);
      assert.equal(res.contentType, "image/svg+xml");
    }
    for (const f of OWNER_CDN) assert.deepEqual(svc.resolve(f, "Svc"), { kind: "proxied", src: `icons/di/${f}` });
    await svc.settle();
    // Resolving warmed the cache: each fetched exactly once.
    assert.deepEqual(cdn.calls.sort(), OWNER_CDN.map((f) => `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${f}`).sort());
    for (const f of OWNER_CDN) {
      const res = await svc.get("di", f, q());
      assert.ok(res, f);
      assert.equal(res.contentType, "image/png");
    }
    assert.equal(cdn.calls.length, OWNER_CDN.length);
  });

  test("AC11: mdi/si with no network; di fetched once then served from cache offline", async () => {
    const cdn = fakeCdn();
    cdn.online = false;
    const offline = service(cdn);
    assert.ok(await offline.get("mdi", "server.svg", q()));
    assert.ok(await offline.get("si", "jellyfin.svg", q()));
    assert.deepEqual(offline.resolve("si-jellyfin", "J"), { kind: "proxied", src: "icons/si/jellyfin.svg" });
    assert.equal(cdn.calls.length, 0);

    cdn.online = true;
    const svc = service(cdn);
    svc.resolve("plex.png", "Plex");
    await svc.settle();
    assert.equal(cdn.calls.length, 1);
    const st = await stat(join(dataDir, "icon-cache", "di", "plex.png"));
    assert.equal(st.mode & 0o777, 0o600);

    cdn.online = false;
    // A fresh service (as after a restart) serves from disk with the network cut.
    const restarted = service(cdn);
    assert.deepEqual(restarted.resolve("plex.png", "Plex"), { kind: "proxied", src: "icons/di/plex.png" });
    const res = await restarted.get("di", "plex.png", q());
    assert.ok(res);
    assert.deepEqual(res.body, PNG);
    assert.equal(cdn.calls.length, 1);
  });

  test("unknown names fall back to the letter", async () => {
    const svc = service(fakeCdn());
    assert.deepEqual(svc.resolve("mdi-does-not-exist-zz", "Grafana"), { kind: "letter", letter: "G" });
    assert.deepEqual(svc.resolve("si-nope-zz", "grafana"), { kind: "letter", letter: "G" });
    assert.deepEqual(svc.resolve(undefined, "HexOS"), { kind: "letter", letter: "H" });
    assert.deepEqual(svc.resolve("", "HexOS"), { kind: "letter", letter: "H" });
    assert.deepEqual(svc.resolve("../../etc/passwd", "X"), { kind: "letter", letter: "X" });
    assert.deepEqual(svc.resolve("/icons/missing.png", "M"), { kind: "letter", letter: "M" });
    assert.equal(svc.resolve(undefined, "  "), undefined);
    assert.deepEqual(svc.resolve("https://example.com/i.png", "E"), { kind: "url", src: "https://example.com/i.png" });
  });

  test("404 is cached negatively for 24 h, then retried; resolve turns into a letter", async () => {
    const cdn = fakeCdn();
    cdn.responder = () => new Response("Couldn't find", { status: 404 });
    const cap = capture();
    const svc = service(cdn, cap.log);
    assert.deepEqual(svc.resolve("nosuch.png", "Nosuch"), { kind: "proxied", src: "icons/di/nosuch.png" });
    await svc.settle();
    assert.equal(await svc.get("di", "nosuch.png", q()), null);
    assert.deepEqual(svc.resolve("nosuch.png", "Nosuch"), { kind: "letter", letter: "N" });
    assert.equal(cdn.calls.length, 1);
    assert.ok(cap.lines.some((l) => l.startsWith("W ") && l.includes("di/nosuch.png") && l.includes("24 h")));
    clock += NEGATIVE_NOT_FOUND_MS - 1000;
    assert.equal(await svc.get("di", "nosuch.png", q()), null);
    assert.equal(cdn.calls.length, 1);
    clock += 2000;
    assert.equal(await svc.get("di", "nosuch.png", q()), null);
    assert.equal(cdn.calls.length, 2);
  });

  test("network failure is cached negatively for 10 min", async () => {
    const cdn = fakeCdn();
    cdn.online = false;
    const svc = service(cdn);
    svc.resolve("plex.png", "Plex");
    await svc.settle();
    assert.equal(cdn.calls.length, 1);
    assert.deepEqual(svc.resolve("plex.png", "Plex"), { kind: "letter", letter: "P" });
    cdn.online = true;
    clock += NEGATIVE_FAILURE_MS + 1;
    assert.deepEqual(svc.resolve("plex.png", "Plex"), { kind: "proxied", src: "icons/di/plex.png" });
    await svc.settle();
    assert.ok(await svc.get("di", "plex.png", q()));
    assert.equal(cdn.calls.length, 2);
  });

  test("the browser cannot trigger fetches for names the config never referenced", async () => {
    const cdn = fakeCdn();
    const svc = service(cdn);
    assert.equal(await svc.get("di", "anything.png", q()), null);
    assert.equal(await svc.get("sh", "anything.png", q()), null);
    assert.equal(cdn.calls.length, 0);
  });

  test("concurrent requests share one fetch (single-flight)", async () => {
    const cdn = fakeCdn();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = cdn.fetch;
    cdn.fetch = async (u, i) => {
      await gate;
      return inner(u, i);
    };
    const svc = service(cdn);
    svc.resolve("sh-jellyfin.svg", "J");
    const all = Promise.all([svc.get("sh", "jellyfin.svg", q()), svc.get("sh", "jellyfin.svg", q())]);
    release();
    const [a, b] = await all;
    assert.ok(a && b);
    assert.equal(a.contentType, "image/svg+xml");
    assert.deepEqual(cdn.calls, ["https://cdn.jsdelivr.net/gh/selfhst/icons/svg/jellyfin.svg"]);
  });

  test("invalid names on the route are refused without I/O", async () => {
    const cdn = fakeCdn();
    const svc = service(cdn);
    for (const [set, name] of [
      ["mdi", "server"], ["mdi", "../server.svg"], ["mdi", "Server.svg"], ["si", "a.png"],
      ["di", "plex"], ["di", "plex.html"], ["di", ".plex.png"], ["sh", "x..png"],
      ["local", "x.yaml"], ["local", "..png"], ["local", ".hidden.png"],
    ] as const) {
      assert.equal(await svc.get(set, name, q()), null, `${set}/${name}`);
    }
    assert.equal(await svc.get("nope" as never, "x.png", q()), null);
    assert.equal(cdn.calls.length, 0);
  });

  test("mdi colour query is applied only when valid", async () => {
    const svc = service(fakeCdn());
    assert.deepEqual(svc.resolve("mdi-server-#00FF00", "S"), { kind: "proxied", src: "icons/mdi/server.svg?c=00ff00" });
    const coloured = await svc.get("mdi", "server.svg", q("c=00ff00"));
    assert.match(coloured!.body.toString(), /^<svg fill="#00ff00"/);
    const ignored = await svc.get("mdi", "server.svg", q("c=red%22%3E"));
    assert.doesNotMatch(ignored!.body.toString(), /fill="#/);
  });

  test("/config/custom-icons wins over the CDN and is served with an allowlisted type", async () => {
    await writeFile(join(configDir, "custom-icons", "plex.png"), PNG);
    await writeFile(join(configDir, "custom-icons", "nas.svg"), SVG);
    const cdn = fakeCdn();
    const svc = service(cdn);
    assert.deepEqual(svc.resolve("plex.png", "Plex"), { kind: "proxied", src: "icons/local/plex.png" });
    assert.deepEqual(svc.resolve("/icons/nas.svg", "Nas"), { kind: "proxied", src: "icons/local/nas.svg" });
    await svc.settle();
    assert.equal(cdn.calls.length, 0);
    const png = await svc.get("local", "plex.png", q());
    assert.equal(png?.contentType, "image/png");
    const svg = await svc.get("local", "nas.svg", q());
    assert.equal(svg?.contentType, "image/svg+xml");
    // The old Homepage folder name is not read (Samba vetoes "icon?").
    await mkdir(join(configDir, "icons"));
    await writeFile(join(configDir, "icons", "old.png"), PNG);
    assert.deepEqual(svc.resolve("/icons/old.png", "Old"), { kind: "letter", letter: "O" });
    assert.equal(await svc.get("local", "old.png", q()), null);
    // sh- names never use the local folder.
    assert.deepEqual(svc.resolve("sh-plex.png", "Plex"), { kind: "proxied", src: "icons/sh/plex.png" });
  });

  test("a leftover icons folder without custom-icons gets a rename hint", async () => {
    await rm(join(configDir, "custom-icons"), { recursive: true });
    await mkdir(join(configDir, "icons"));
    const cap = capture();
    service(fakeCdn(), cap.log);
    assert.ok(cap.lines.some((l) => l.includes("custom-icons folder, not icons")));
    await mkdir(join(configDir, "custom-icons"));
    const quiet = capture();
    service(fakeCdn(), quiet.log);
    assert.ok(!quiet.lines.some((l) => l.includes("rename the folder")));
  });

  test("local icons: symlink escape, unsafe SVG, mislabelled and oversize files are refused", async () => {
    const outside = join(root, "secret.png");
    await writeFile(outside, PNG);
    await symlink(outside, join(configDir, "custom-icons", "escape.png"));
    await writeFile(join(configDir, "custom-icons", "evil.svg"), "<svg><script>alert(1)</script></svg>");
    await writeFile(
      join(configDir, "custom-icons", "evil-ns.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
    );
    await writeFile(join(configDir, "custom-icons", "fake.png"), "<html><script>x</script></html>");
    await writeFile(join(configDir, "custom-icons", "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_ICON_BYTES)]));
    await mkdir(join(configDir, "custom-icons", "dir.png"));
    const cap = capture();
    const svc = service(fakeCdn(), cap.log);
    for (const f of ["escape.png", "evil.svg", "evil-ns.svg", "fake.png", "huge.png", "dir.png", "absent.png"]) {
      assert.equal(await svc.get("local", f, q()), null, f);
    }
    assert.ok(cap.lines.some((l) => l.includes("outside the custom-icons folder")));
    // A symlink inside the folder pointing to another file inside it is fine.
    await writeFile(join(configDir, "custom-icons", "real.png"), PNG);
    await symlink(join(configDir, "custom-icons", "real.png"), join(configDir, "custom-icons", "alias.png"));
    assert.ok(await svc.get("local", "alias.png", q()));
  });

  test("a tampered cache file is discarded", async () => {
    await mkdir(join(dataDir, "icon-cache", "di"), { recursive: true });
    await writeFile(join(dataDir, "icon-cache", "di", "plex.png"), "<html>");
    const svc = service(fakeCdn());
    assert.equal(await svc.get("di", "plex.png", q()), null);
    assert.equal(existsSync(join(dataDir, "icon-cache", "di", "plex.png")), false);
  });

  test("cache is capped, evicting the least recently used", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(400)]);
    const cdn = fakeCdn();
    cdn.responder = () => new Response(new Uint8Array(big), { status: 200, headers: { "content-type": "image/png" } });
    const svc = service(cdn, capture().log, { cacheCapBytes: big.length * 2 + 10 });
    const dir = join(dataDir, "icon-cache", "di");
    svc.resolve("a.png", "A");
    await svc.settle();
    svc.resolve("b.png", "B");
    await svc.settle();
    // Make a.png the most recently used, b.png old.
    await utimes(join(dir, "b.png"), new Date(1000), new Date(1000));
    await utimes(join(dir, "a.png"), new Date(), new Date());
    svc.resolve("c.png", "C");
    await svc.settle();
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ["a.png", "c.png"]);
  });
});

describe("icons: HTTP route", () => {
  test("headers: allowlisted type, ICON_CSP, nosniff; traversal 404s", async () => {
    await writeFile(join(configDir, "custom-icons", "nas.svg"), SVG);
    const ctx: BootContext = {
      options: { log_level: "info" },
      paths: { configDir, dataDir, sampleDir: join(APP, "sample"), webDir: join(APP, "web") },
      configPathDisplay: "/addon_configs/abcd1234_homelab/",
      log: capture().log,
    };
    const icons = createIconService(ctx, { fetch: fakeCdn().fetch, now: () => clock });
    icons.resolve("plex.png", "Plex");
    await icons.settle();
    const server = buildHttpServer(ctx, { config: createStubConfigService(ctx, "ok"), state: createStubStateService(ctx), icons }, false);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const get = (path: string) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        });
        req.on("error", reject);
        req.end();
      });
    try {
      for (const [path, ct] of [
        ["/icons/mdi/server.svg", "image/svg+xml"],
        ["/icons/si/jellyfin.svg", "image/svg+xml"],
        ["/icons/di/plex.png", "image/png"],
        ["/icons/local/nas.svg", "image/svg+xml"],
      ] as const) {
        const r = await get(path);
        assert.equal(r.status, 200, path);
        assert.equal(r.headers["content-type"], ct, path);
        assert.equal(r.headers["content-security-policy"], ICON_CSP, path);
        assert.equal(r.headers["x-content-type-options"], "nosniff", path);
      }
      for (const path of [
        "/icons/local/..%2f..%2fdata%2foptions.json", "/icons/local/../../etc/passwd", "/icons/di/https%3A%2F%2Fevil.example%2Fx.png",
        "/icons/di/never-referenced.png", "/icons/mdi/%2e%2e%2fserver.svg",
      ]) {
        assert.equal((await get(path)).status, 404, path);
      }
    } finally {
      server.close();
    }
  });
});
