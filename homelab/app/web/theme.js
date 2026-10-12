// @ts-check
// Theme bridge (design §5, UX §7). The ingress iframe is same-origin with HA,
// so we READ the active HA theme's CSS variables from the parent document and
// write our own --hl-* tokens onto our :root with style.setProperty. We never
// write to, navigate or message the parent (threat model R5).
// Fallback: prefers-color-scheme with the built-in tokens in styles.css.
// The app option theme: light|dark forces a token set and skips the bridge.
//
// The colour maths and computeTheme() are pure and unit-tested
// (test/unit/web-theme.test.js); startThemeBridge() is the browser glue.

/** @typedef {[number, number, number, number]} RGBA  r,g,b 0..255, a 0..1 */
/** @typedef {"light" | "dark"} Scheme */

/**
 * Built-in token values (UX §7.2) that matter for the contrast guard. The full
 * token set lives in styles.css; keep the two in sync.
 */
export const TOKENS = Object.freeze({
  light: { card: "#ffffff", text: "#212121", up: "#1b7a2e", down: "#c62828", warn: "#8a5300", unknown: "#5f6368", focus: "#0277bd" },
  dark: { card: "#1c1c1c", text: "#e1e1e1", up: "#5cc66b", down: "#ff6b6b", warn: "#ffb74d", unknown: "#9b9b9b", focus: "#03a9f4" },
});

/** HA variables we read (UX §7.1). */
export const HA_VARS = Object.freeze([
  "--primary-background-color",
  "--card-background-color",
  "--ha-card-background",
  "--primary-text-color",
  "--secondary-text-color",
  "--divider-color",
  "--primary-color",
  "--ha-card-border-radius",
  "--ha-card-box-shadow",
  "--ha-card-border-width",
  "--ha-card-border-color",
  "--ha-font-family-body",
  "--paper-font-body1_-_font-family",
]);

/** Every property computeTheme() may set; removed when not set. */
export const OUR_VARS = Object.freeze([
  "--hl-bg", "--hl-card", "--hl-text", "--hl-text-2", "--hl-divider", "--hl-primary", "--hl-focus",
  "--hl-radius", "--hl-shadow", "--hl-border-width", "--hl-border-color", "--hl-font",
  "--hl-status-up", "--hl-status-down", "--hl-status-warn", "--hl-status-unknown",
  "--hl-status-up-text", "--hl-status-down-text", "--hl-status-warn-text", "--hl-status-unknown-text",
]);

/**
 * Parse a CSS colour: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() (comma or
 * space syntax) and color(srgb r g b [/ a]). Returns null for anything else.
 * @param {string} input @returns {RGBA | null}
 */
export function parseColor(input) {
  const s = String(input).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = /** @type {string} */ (m[1]);
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (/** @type {number} */ i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (m) {
    const parts = /** @type {string} */ (m[1]).split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (/** @type {string} */ p) => (p.endsWith("%") ? (parseFloat(p) * 255) / 100 : parseFloat(p));
    const rgb = parts.slice(0, 3).map(ch);
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if (rgb.some((v) => !Number.isFinite(v)) || !Number.isFinite(a)) return null;
    return [clamp255(rgb[0] ?? 0), clamp255(rgb[1] ?? 0), clamp255(rgb[2] ?? 0), Math.min(1, Math.max(0, a))];
  }
  m = /^color\(\s*srgb\s+([^)]*)\)$/.exec(s);
  if (m) {
    const parts = /** @type {string} */ (m[1]).split(/[\s/]+/).filter(Boolean).map(parseFloat);
    if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) return null;
    return [clamp255((parts[0] ?? 0) * 255), clamp255((parts[1] ?? 0) * 255), clamp255((parts[2] ?? 0) * 255), Math.min(1, Math.max(0, parts[3] ?? 1))];
  }
  return null;
}

/** @param {number} v */
function clamp255(v) {
  return Math.min(255, Math.max(0, v));
}

/** Composite a (possibly translucent) colour over an opaque background. @param {RGBA} fg @param {RGBA} bg @returns {RGBA} */
export function composite(fg, bg) {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

/** WCAG relative luminance. @param {RGBA} c */
export function luminance(c) {
  const lin = (/** @type {number} */ v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio of two opaque colours. @param {RGBA} a @param {RGBA} b */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** @param {RGBA} c */
export function toCss(c) {
  const r = (/** @type {number} */ v) => Math.round(v);
  return c[3] >= 1 ? `rgb(${r(c[0])}, ${r(c[1])}, ${r(c[2])})` : `rgba(${r(c[0])}, ${r(c[1])}, ${r(c[2])}, ${+c[3].toFixed(3)})`;
}

const WHITE = /** @type {RGBA} */ ([255, 255, 255, 1]);
const BLACK = /** @type {RGBA} */ ([0, 0, 0, 1]);

/** Dark when white text contrasts better than black. @param {RGBA} bg @returns {Scheme} */
export function schemeFor(bg) {
  return contrast(bg, WHITE) > contrast(bg, BLACK) ? "dark" : "light";
}

const LENGTH_RE = /^\d{1,3}(\.\d{1,3})?(px|rem|em)$|^0$/;
/** Shadows/fonts: plain tokens only; never anything that can load a resource. */
const SAFE_TEXT_RE = /^[-\w\s.,()#%"']{1,300}$/;

/** @param {string} v */
function safeText(v) {
  return SAFE_TEXT_RE.test(v) && !/url\s*\(|image|expression/i.test(v) ? v : "";
}

/**
 * Decide the scheme and the --hl-* overrides.
 * @param {"auto" | "light" | "dark"} option  app option (UX §7.1 #3)
 * @param {Record<string, string> | null} haVars  raw values read from the parent (null = not readable)
 * @param {boolean} prefersDark
 * @param {(value: string) => string} [resolve]  turns any CSS colour into rgb(); identity in tests
 * @returns {{ scheme: Scheme, source: "option" | "ha" | "system", vars: Record<string, string> }}
 */
export function computeTheme(option, haVars, prefersDark, resolve = (v) => v) {
  if (option === "light" || option === "dark") return { scheme: option, source: "option", vars: {} };
  const color = (/** @type {string | undefined} */ v) => (v ? parseColor(resolve(v)) : null);
  const bgRaw = color(haVars?.["--primary-background-color"]);
  if (!haVars || !bgRaw) return { scheme: prefersDark ? "dark" : "light", source: "system", vars: {} };

  const bg = composite(bgRaw, WHITE);
  const scheme = schemeFor(bg);
  const t = TOKENS[scheme];
  const cardRaw = color(haVars["--card-background-color"]) ?? color(haVars["--ha-card-background"]);
  const card = cardRaw ? composite(cardRaw, bg) : /** @type {RGBA} */ (parseColor(t.card));
  const textRaw = color(haVars["--primary-text-color"]);
  const text = textRaw ? composite(textRaw, card) : /** @type {RGBA} */ (parseColor(t.text));

  /** @type {Record<string, string>} */
  const vars = { "--hl-bg": toCss(bg), "--hl-card": toCss(card), "--hl-text": toCss(text) };
  const text2 = color(haVars["--secondary-text-color"]);
  if (text2) vars["--hl-text-2"] = toCss(composite(text2, card));
  const divider = color(haVars["--divider-color"]);
  if (divider) vars["--hl-divider"] = toCss(divider);
  const primary = color(haVars["--primary-color"]);
  if (primary) {
    const p = composite(primary, card);
    vars["--hl-primary"] = toCss(p);
    // Focus ring: theme primary only if >= 3:1 on the card (UX §6.2).
    vars["--hl-focus"] = toCss(contrast(p, card) >= 3 ? p : text);
  } else if (contrast(/** @type {RGBA} */ (parseColor(t.focus)), card) < 3) {
    vars["--hl-focus"] = toCss(text);
  }

  // Contrast guard (UX §7.2): status words need 4.5:1 on the card, icons 3:1.
  for (const k of /** @type {const} */ (["up", "down", "warn", "unknown"])) {
    const c = /** @type {RGBA} */ (parseColor(t[k]));
    const ratio = contrast(c, card);
    if (ratio < 4.5) vars[`--hl-status-${k}-text`] = toCss(text);
    if (ratio < 3) vars[`--hl-status-${k}`] = toCss(text);
  }

  const radius = (haVars["--ha-card-border-radius"] ?? "").trim();
  if (LENGTH_RE.test(radius)) vars["--hl-radius"] = radius;
  const bw = (haVars["--ha-card-border-width"] ?? "").trim();
  if (LENGTH_RE.test(bw)) vars["--hl-border-width"] = bw;
  const bc = color(haVars["--ha-card-border-color"]);
  if (bc) vars["--hl-border-color"] = toCss(bc);
  const shadow = safeText((haVars["--ha-card-box-shadow"] ?? "").trim());
  if (shadow) vars["--hl-shadow"] = shadow;
  const font = safeText((haVars["--ha-font-family-body"] || haVars["--paper-font-body1_-_font-family"] || "").trim());
  if (font) vars["--hl-font"] = font;
  return { scheme, source: "ha", vars };
}

// ---------------------------------------------------------------------------
// Browser glue
// ---------------------------------------------------------------------------

/**
 * Read the HA variables from the parent document. null when there is no
 * parent, it is cross-origin (SecurityError), or no HA theme is present.
 * @returns {Record<string, string> | null}
 */
export function readParentVars() {
  try {
    if (window.parent === window) return null;
    const root = window.parent.document.documentElement;
    const cs = window.parent.getComputedStyle(root);
    /** @type {Record<string, string>} */
    const out = {};
    for (const name of HA_VARS) {
      const v = cs.getPropertyValue(name).trim();
      if (v) out[name] = v;
    }
    return out["--primary-background-color"] ? out : null;
  } catch {
    // Cross-origin (e.g. opened directly in a test harness): use the fallback.
    return null;
  }
}

/** Resolve any CSS colour (names, var-free color-mix, hsl...) to rgb() via a probe element. */
function makeResolver() {
  /** @type {HTMLElement | null} */
  let probe = null;
  return (/** @type {string} */ value) => {
    if (parseColor(value)) return value;
    if (!probe) {
      probe = document.createElement("span");
      probe.hidden = true;
      probe.setAttribute("aria-hidden", "true");
      document.body.appendChild(probe);
    }
    probe.style.color = "";
    probe.style.color = value;
    if (!probe.style.color) return "";
    return getComputedStyle(probe).color;
  };
}

/**
 * Start the bridge. Returns setOption() for when api/config arrives or changes.
 * @param {"auto" | "light" | "dark"} [initial]
 */
export function startThemeBridge(initial = "auto") {
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const resolve = makeResolver();
  let option = initial;
  let last = "";

  const apply = () => {
    const parentVars = option === "auto" ? readParentVars() : null;
    const theme = computeTheme(option, parentVars, media.matches, resolve);
    const key = JSON.stringify(theme);
    if (key === last) return;
    last = key;
    root.dataset.theme = theme.scheme;
    root.dataset.themeSource = theme.source;
    root.style.setProperty("color-scheme", theme.scheme);
    for (const name of OUR_VARS) {
      const v = theme.vars[name];
      if (v) root.style.setProperty(name, v);
      else root.style.removeProperty(name);
    }
  };

  apply();
  media.addEventListener("change", apply);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) apply();
  });
  // HA sends no theme event: watch the parent <html> style/class, plus a 5 s safety net.
  try {
    if (window.parent !== window) {
      const target = window.parent.document.documentElement;
      new MutationObserver(apply).observe(target, { attributes: true, attributeFilter: ["style", "class"] });
      const head = window.parent.document.head;
      if (head) new MutationObserver(apply).observe(head, { childList: true });
    }
  } catch {
    // Cross-origin parent: the interval and media listener still run.
  }
  setInterval(() => {
    if (!document.hidden) apply();
  }, 5000);

  return {
    /** @param {"auto" | "light" | "dark"} next */
    setOption(next) {
      if (next === option) return;
      option = next;
      apply();
    },
  };
}
