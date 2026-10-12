import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExcerpt, redactLine } from "../../src/config/excerpt.ts";
import { parseYaml } from "../../src/config/parse.ts";
import { resolveScalar } from "../../src/config/secrets.ts";
import { checkPingHost, checkUrl, isIconName, sanitiseIconRef, urlSecrets, withoutUserinfo } from "../../src/config/urls.ts";

test("redactLine: secret-looking keys, sensitive lines and known secrets", () => {
  assert.equal(redactLine("    key: abc123", false, []), "    key: ••••••");
  assert.equal(redactLine("  - password: 'x y'", false, []), "  - password: ••••••");
  assert.equal(redactLine("  apiKey: abc # comment", false, []), "  apiKey: ••••••");
  assert.equal(redactLine("  href: http://a.lan/", false, []), "  href: http://a.lan/");
  assert.equal(redactLine("  X-Custom: value", true, []), "  X-Custom: ••••••");
  assert.equal(redactLine("  - value", true, []), "  - ••••••");
  assert.equal(redactLine("  note: has SECRETVALUE inside", false, ["SECRETVALUE"]), "  note: has •••• inside");
  assert.equal(redactLine("  url: http://u:p@host/", false, []), "  url: http://••••@host/");
  assert.equal(redactLine("  key:", false, []), "  key:", "empty value stays");
  assert.ok(redactLine("x".repeat(500), false, []).length <= 201);
});

test("buildExcerpt: ±1 line clamped to the file", () => {
  const lines = ["a: 1", "b: 2", "c: 3"];
  assert.deepEqual(buildExcerpt(lines, 1, new Set(), []), { startLine: 1, lines: ["a: 1", "b: 2"], markLine: 1 });
  assert.deepEqual(buildExcerpt(lines, 3, new Set(), []), { startLine: 2, lines: ["b: 2", "c: 3"], markLine: 3 });
  assert.equal(buildExcerpt(lines, undefined, new Set(), []), undefined);
  assert.equal(buildExcerpt([], 1, new Set(), []), undefined);
});

test("parseYaml: positions are 1-based and keys/values carry lines", () => {
  const p = parseYaml("services.yaml", "- G:\n    - A:\n        href: x\n");
  assert.deepEqual(p.errors, []);
  assert.equal(p.root?.kind, "seq");
  const g = p.root!.kind === "seq" ? p.root!.items[0]! : null;
  assert.equal(g?.kind === "map" ? g.entries[0]!.keyLine : 0, 1);
});

test("resolveScalar: placeholders inside text and unsupported forms", () => {
  const sec = new Map([["HOST", "nas.lan"], ["HOMEPAGE_VAR_PORT", "8080"]]);
  const sc = (value: string, tag?: string) => ({ kind: "scalar" as const, value, line: 1, col: 1, endLine: 1, ...(tag ? { tag } : {}) });
  assert.deepEqual(resolveScalar(sc("http://{{HOMEPAGE_VAR_HOST}}:{{ HOMEPAGE_VAR_PORT }}/"), sec), { ok: true, value: "http://nas.lan:8080/", fromSecret: true });
  assert.deepEqual(resolveScalar(sc("plain"), sec), { ok: true, value: "plain", fromSecret: false });
  assert.equal(resolveScalar(sc("{{HOMEPAGE_FILE_X}}"), sec).ok, false);
  assert.equal(resolveScalar(sc("", "!secret"), sec).ok, false);
});

test("urls: checkUrl, userinfo, ping hosts, icon names", () => {
  assert.equal(checkUrl("javascript:alert(1)"), null);
  assert.equal(checkUrl("http://"), null);
  assert.equal(checkUrl("http://a b/"), null);
  assert.equal(checkUrl("wss://nas.lan", ["ws:", "wss:"])?.url.protocol, "wss:");
  const c = checkUrl("http://u:p%40ss@h.lan/?apikey=K1&x=1")!;
  assert.equal(c.hadUserinfo, true);
  assert.equal(withoutUserinfo(c.url), "http://h.lan/?apikey=K1&x=1");
  assert.deepEqual(urlSecrets(c.url).sort(), ["K1", "p%40ss", "p@ss", "u"].sort());
  assert.equal(checkPingHost("-c1"), null);
  assert.equal(checkPingHost("a;rm -rf"), null);
  assert.equal(checkPingHost("nas.lan"), "nas.lan");
  assert.equal(checkPingHost("192.0.2.1"), "192.0.2.1");
  assert.equal(checkPingHost("fe80::1%eth0"), "fe80::1%eth0");
  for (const ok of ["mdi-server", "si-plex-#ff0000", "plex.png", "sh-truenas.svg", "/icons/my.png", "Jellyfin"]) assert.ok(isIconName(ok), ok);
  for (const bad of ["../x.png", "/icons/../../etc/passwd", "javascript:alert(1)", "a b", "/etc/passwd", ""]) assert.ok(!isIconName(bad), bad);
  assert.deepEqual(sanitiseIconRef({ kind: "proxied", src: "icons/di/plex.png" }, "P"), { kind: "proxied", src: "icons/di/plex.png" });
  assert.deepEqual(sanitiseIconRef({ kind: "proxied", src: "icons/mdi/x.svg?c=ff0000" }, "P"), { kind: "proxied", src: "icons/mdi/x.svg?c=ff0000" });
  assert.deepEqual(sanitiseIconRef({ kind: "proxied", src: "/api/x" }, "P"), { kind: "letter", letter: "P" });
  assert.equal(sanitiseIconRef(undefined, "  "), undefined);
});
