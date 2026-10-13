// Theme bridge maths (web/theme.js): colour parsing, contrast, scheme choice,
// HA variable mapping and the contrast guard (UX §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { composite, computeTheme, contrast, parseColor, schemeFor, toCss } from "../../web/theme.js";

const near = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("parseColor handles hex, rgb(a) comma/space syntax and color(srgb)", () => {
  assert.deepEqual(parseColor("#fff"), [255, 255, 255, 1]);
  assert.deepEqual(parseColor("#03A9F4"), [3, 169, 244, 1]);
  assert.deepEqual(parseColor("#00000080"), [0, 0, 0, 128 / 255]);
  assert.deepEqual(parseColor("rgb(28, 28, 28)"), [28, 28, 28, 1]);
  assert.deepEqual(parseColor("rgba(0,0,0,.12)"), [0, 0, 0, 0.12]);
  assert.deepEqual(parseColor("rgb(10 20 30 / 50%)"), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor("color(srgb 1 0 0)"), [255, 0, 0, 1]);
  for (const bad of ["red", "url(x)", "#12", "rgb(1,2)", "", "var(--x)"]) assert.equal(parseColor(bad), null, bad);
});

test("WCAG contrast matches the UX token table", () => {
  const white = parseColor("#ffffff");
  near(contrast(parseColor("#1b7a2e"), white), 5.4, 0.1);
  near(contrast(parseColor("#c62828"), white), 5.6, 0.1);
  near(contrast(parseColor("#03a9f4"), white), 2.6, 0.1);
  near(contrast(parseColor("#5cc66b"), parseColor("#1c1c1c")), 7.9, 0.2);
  near(contrast(white, white), 1, 0);
});

test("composite and scheme detection", () => {
  assert.deepEqual(composite([0, 0, 0, 0.5], [255, 255, 255, 1]), [127.5, 127.5, 127.5, 1]);
  assert.equal(schemeFor(parseColor("#fafafa")), "light");
  assert.equal(schemeFor(parseColor("#111111")), "dark");
  assert.equal(toCss([1, 2, 3, 1]), "rgb(1, 2, 3)");
  assert.equal(toCss([1, 2, 3, 0.5]), "rgba(1, 2, 3, 0.5)");
});

test("without a readable parent falls back to prefers-color-scheme", () => {
  assert.deepEqual(computeTheme(null, true), { scheme: "dark", source: "system", vars: {} });
  assert.deepEqual(computeTheme(null, false), { scheme: "light", source: "system", vars: {} });
  assert.equal(computeTheme({ "--primary-background-color": "nonsense" }, true).source, "system");
});

test("HA dark theme maps variables and picks the dark set", () => {
  const t = computeTheme({
    "--primary-background-color": "#111111",
    "--card-background-color": "#1c1c1c",
    "--primary-text-color": "#e1e1e1",
    "--secondary-text-color": "#9b9b9b",
    "--divider-color": "rgba(225, 225, 225, 0.12)",
    "--primary-color": "#03a9f4",
    "--ha-card-border-radius": "16px",
    "--ha-card-border-width": "1px",
    "--ha-font-family-body": "Roboto, Noto, sans-serif",
  }, false);
  assert.equal(t.scheme, "dark");
  assert.equal(t.source, "ha");
  assert.equal(t.vars["--hl-bg"], "rgb(17, 17, 17)");
  assert.equal(t.vars["--hl-card"], "rgb(28, 28, 28)");
  assert.equal(t.vars["--hl-text-2"], "rgb(155, 155, 155)");
  assert.equal(t.vars["--hl-focus"], "rgb(3, 169, 244)", "primary is >= 3:1 on dark card");
  assert.equal(t.vars["--hl-radius"], "16px");
  assert.equal(t.vars["--hl-font"], "Roboto, Noto, sans-serif");
  assert.equal(t.vars["--hl-status-up-text"], undefined, "default dark tokens pass on the default card");
});

test("light HA theme: low-contrast primary is not used for focus", () => {
  const t = computeTheme({ "--primary-background-color": "#fafafa", "--card-background-color": "#ffffff", "--primary-text-color": "#212121", "--primary-color": "#03a9f4" }, true);
  assert.equal(t.scheme, "light");
  assert.equal(t.vars["--hl-primary"], "rgb(3, 169, 244)");
  assert.equal(t.vars["--hl-focus"], "rgb(33, 33, 33)");
});

test("contrast guard: status colours that fail on the theme's card fall back to text", () => {
  // A light theme with a mid-green card: the light status greens/reds fail 4.5:1.
  const t = computeTheme({ "--primary-background-color": "#e8f5e9", "--card-background-color": "#4caf50", "--primary-text-color": "#000000" }, false);
  assert.equal(t.scheme, "light");
  assert.equal(t.vars["--hl-status-up-text"], "rgb(0, 0, 0)");
  assert.equal(t.vars["--hl-status-up"], "rgb(0, 0, 0)", "icon also below 3:1");
  assert.equal(t.vars["--hl-status-down-text"], "rgb(0, 0, 0)");
});

test("translucent card colours are composited; unsafe shadow/font/length values are dropped", () => {
  const t = computeTheme({
    "--primary-background-color": "#ffffff",
    "--card-background-color": "rgba(0, 0, 0, 0.5)",
    "--ha-card-box-shadow": "url(https://evil.example/x) 0 0",
    "--ha-font-family-body": "x; background-image: url(https://evil.example)",
    "--ha-card-border-radius": "calc(1px + url(x))",
  }, false);
  assert.equal(t.vars["--hl-card"], "rgb(128, 128, 128)");
  assert.equal(t.vars["--hl-shadow"], undefined);
  assert.equal(t.vars["--hl-font"], undefined);
  assert.equal(t.vars["--hl-radius"], undefined);
});

test("delta 4 / M3: status words are checked against the tinted pill, not the card", async () => {
  const { PILL_ALPHA } = await import("../../web/theme.js");
  // Dark theme with a dark red card: "Down" (#ff6b6b) is ~4:1 on its own tint.
  const t = computeTheme({ "--primary-background-color": "#1a0000", "--card-background-color": "#5a1010", "--primary-text-color": "#ffffff" }, true);
  assert.equal(t.scheme, "dark");
  const card = parseColor(t.vars["--hl-card"]);
  const down = parseColor("#ff6b6b");
  const pill = composite([down[0], down[1], down[2], PILL_ALPHA.dark], card);
  assert.ok(contrast(down, pill) < 4.5, "precondition: fails on the tint");
  assert.equal(t.vars["--hl-status-down-text"], "rgb(255, 255, 255)");
  const word = parseColor(t.vars["--hl-status-down-text"]);
  assert.ok(contrast(word, pill) >= 4.5);
});

test("delta 4: text colour that also fails on the tint falls back to black or white", () => {
  // Mid-grey text on a mid-green card: neither status green nor the text reaches 4.5:1.
  const t = computeTheme({ "--primary-background-color": "#f0f0f0", "--card-background-color": "#4caf50", "--primary-text-color": "#666666" }, false);
  assert.equal(t.vars["--hl-status-up-text"], "rgb(0, 0, 0)");
});

test("delta 4: low-contrast theme secondary text is stepped toward the text colour", async () => {
  const { ensureContrast } = await import("../../web/theme.js");
  const t = computeTheme({ "--primary-background-color": "#ffffff", "--card-background-color": "#ffffff", "--primary-text-color": "#212121", "--secondary-text-color": "#aaaaaa" }, false);
  const t2 = parseColor(t.vars["--hl-text-2"]);
  assert.ok(contrast(t2, parseColor("#ffffff")) >= 4.5);
  assert.notEqual(t.vars["--hl-text-2"], "rgb(33, 33, 33)", "a step, not the full text colour");
  const ok = computeTheme({ "--primary-background-color": "#ffffff", "--secondary-text-color": "#5f6368" }, false);
  assert.equal(ok.vars["--hl-text-2"], "rgb(95, 99, 104)", "passing colours are unchanged");
  assert.deepEqual(ensureContrast([255, 255, 255, 1], [0, 0, 0, 1], [255, 255, 255, 1], 21), [0, 0, 0, 1]);
});
