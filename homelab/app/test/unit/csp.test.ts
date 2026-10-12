import { test } from "node:test";
import assert from "node:assert/strict";
import { CSP, ICON_CSP, newNonce, pageCsp } from "../../src/http/respond.ts";
import { NONCE_PLACEHOLDER, injectNonce, scriptsWithoutNonce } from "../../src/http/static.ts";

function directives(csp: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of csp.split(";")) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out.set(name, rest.join(" "));
  }
  return out;
}

test("ICON_CSP sandboxes the document and blocks everything but inline style", () => {
  const d = directives(ICON_CSP);
  assert.ok(d.has("sandbox"));
  assert.equal(d.get("sandbox"), "");
  assert.equal(d.get("default-src"), "'none'");
  assert.equal(d.get("style-src"), "'unsafe-inline'");
});

test("CSP and page CSP forbid objects and workers and keep frame/base/form rules", () => {
  for (const csp of [CSP, pageCsp(newNonce())]) {
    const d = directives(csp);
    assert.equal(d.get("object-src"), "'none'");
    assert.equal(d.get("worker-src"), "'none'");
    assert.equal(d.get("frame-ancestors"), "'self'");
    assert.equal(d.get("base-uri"), "'none'");
    assert.equal(d.get("form-action"), "'none'");
    assert.equal(d.get("style-src"), "'self' 'unsafe-inline'");
  }
  assert.equal(directives(CSP).has("script-src"), false);
});

test("pageCsp: script-src is the nonce only", () => {
  const n = newNonce();
  assert.equal(directives(pageCsp(n)).get("script-src"), `'nonce-${n}'`);
});

test("pageCsp rejects anything that isn't a base64 nonce", () => {
  for (const bad of ["", "short", "abc'; script-src *", "AAAAAAAAAAAAAAAAAAAAAA== x", "AAAAAAAAAAAAAAAA\n"]) {
    assert.throws(() => pageCsp(bad), /invalid CSP nonce/);
  }
});

test("newNonce: 16 random bytes, base64, different each call", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const n = newNonce();
    assert.match(n, /^[A-Za-z0-9+/]{22}==$/);
    assert.equal(Buffer.from(n, "base64").length, 16);
    seen.add(n);
  }
  assert.equal(seen.size, 100);
});

test("injectNonce replaces every placeholder and nothing else", () => {
  const html = `<script type="module" nonce="${NONCE_PLACEHOLDER}" src="a.js"></script><p>$& $1 ${"x"}</p><script nonce="${NONCE_PLACEHOLDER}" src="b.js"></script>`;
  const out = injectNonce(Buffer.from(html), "AbC+/xyz0123456789abcd==").toString("utf8");
  assert.equal(out.split('nonce="AbC+/xyz0123456789abcd=="').length, 3);
  assert.ok(!out.includes(NONCE_PLACEHOLDER));
  assert.ok(out.includes("<p>$& $1 x</p>"));
});

test("injectNonce refuses a nonce that could break out of the attribute", () => {
  for (const bad of ['a" onload="x', "a b", "<", ""]) {
    assert.throws(() => injectNonce(Buffer.from("x"), bad), /invalid CSP nonce/);
  }
});

test("scriptsWithoutNonce counts script tags missing the placeholder", () => {
  assert.equal(scriptsWithoutNonce(`<script nonce="${NONCE_PLACEHOLDER}" src="a.js"></script>`), 0);
  assert.equal(scriptsWithoutNonce(`<script src="a.js"></script><SCRIPT type="module">x</SCRIPT>`), 2);
  assert.equal(scriptsWithoutNonce("<p>no scripts</p>"), 0);
});
