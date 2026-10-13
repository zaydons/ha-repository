// Static checks over web/ for the binding rendering rules (threat model R1-R3,
// R5, C1, C4) and ingress-relative URLs (design §1.2 rule 6, AC4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
function files(dir = WEB) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const sources = files().filter((f) => /\.(js|html|css)$/.test(f)).map((f) => ({ name: relative(WEB, f), text: readFileSync(f, "utf8") }));
const js = sources.filter((s) => s.name.endsWith(".js"));

test("no HTML sinks, eval or import maps in web/ (R1)", () => {
  const banned = [
    /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /dangerouslySetInnerHTML/,
    /\beval\s*\(/, /new\s+Function\s*\(/, /setTimeout\s*\(\s*["'`]/, /setInterval\s*\(\s*["'`]/, /importmap/, /\bsrcdoc\b/,
    /createContextualFragment/, /DOMParser/,
  ];
  for (const s of sources) for (const re of banned) assert.doesNotMatch(s.text, re, `${s.name}: ${re}`);
});

test("no absolute-path URLs (ingress sub-path) and no parent/top navigation (R2)", () => {
  for (const s of sources) {
    assert.doesNotMatch(s.text, /["'(`]\/(api|static|icons|vendor)\b/, s.name);
    assert.doesNotMatch(s.text, /\b(window\.)?(top|parent)\.location\b/, s.name);
    assert.doesNotMatch(s.text, /\.open\s*\(/, `${s.name}: window.open`);
  }
});

test("every external link opens in a new tab with noopener noreferrer (R2)", () => {
  for (const s of js) {
    const anchors = s.text.match(/<a\b[^>]*>/g) ?? [];
    for (const a of anchors) {
      assert.match(a, /target="_blank"/, `${s.name}: ${a}`);
      assert.match(a, /rel="noopener noreferrer"/, `${s.name}: ${a}`);
    }
  }
});

test("theme bridge only reads the parent; no message listeners or postMessage (R5)", () => {
  for (const s of js) {
    assert.doesNotMatch(s.text, /postMessage/, s.name);
    assert.doesNotMatch(s.text, /addEventListener\(\s*["']message["']/, s.name);
    assert.doesNotMatch(s.text, /onmessage/, s.name);
    // Any write through window.parent would look like parent...style/setProperty/setAttribute.
    assert.doesNotMatch(s.text, /parent\.document\.[\w.]*(setAttribute|style\.|appendChild|setProperty)/, s.name);
  }
});

test("index.html: only nonced module scripts, no inline script or style (C1, C4)", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scripts.length >= 1);
  for (const tag of scripts) {
    assert.match(tag, /nonce="__CSP_NONCE__"/, tag);
    assert.match(tag, /type="module"/, tag);
    assert.match(tag, /src="static\//, tag);
  }
  assert.doesNotMatch(html, /<script\b[^>]*>\s*\S[\s\S]*?<\/script>/, "no inline script bodies");
  assert.doesNotMatch(html, /<style\b/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
});

test("components set styles only through Preact style objects (C4)", () => {
  for (const s of js) {
    assert.doesNotMatch(s.text, /\sstyle="/, s.name);
    assert.doesNotMatch(s.text, /style=\$\{\s*["'`]/, `${s.name}: string style`);
    assert.doesNotMatch(s.text, /cssText/, s.name);
    assert.doesNotMatch(s.text, /createElement\(\s*["']style["']/, s.name);
    assert.doesNotMatch(s.text, /setAttribute\(\s*["']style["']/, s.name);
  }
});

test("no inline SVG from data: icons only via <img src> (R3)", () => {
  for (const s of js) {
    if (s.name === "icons.js") continue;
    assert.doesNotMatch(s.text, /mask-image|maskImage/, `${s.name}: icons go through <img>, not CSS masks`);
  }
  // The only <svg> element is the static glyph component fed from bundled path constants.
  const svgUsers = js.filter((s) => s.name !== "icons.js" && /<svg\b/.test(s.text)).map((s) => s.name);
  assert.deepEqual(svgUsers, [join("components", "Glyph.js")]);
});

test("stat values are never ellipsized; labels and free text yield first (F-2)", () => {
  const css = readFileSync(join(WEB, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(",").some((s) => s.trim() === sel)).map((m) => m[2]);
  assert.match(rules(".stats").join(";"), /grid-template-columns:\s*repeat\(var\(--n, 4\), minmax\(auto, 1fr\)\)/);
  const value = rules(".stat-value").join(";");
  assert.match(value, /min-width:\s*auto/);
  assert.doesNotMatch(value, /overflow|text-overflow|min-width:\s*0/, "a formatted value keeps its full width");
  assert.match(rules(".stat-label").join(";"), /min-width:\s*0[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(rules(".stat-value.is-text").join(";"), /text-overflow:\s*ellipsis/);
});
