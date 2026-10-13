// @ts-check
// View model: turns PublicConfig + StateSnapshot (design §4.4) into what the
// components draw, using the UX copy deck (ux.md §5, §11, §14). Pure functions,
// no DOM, no HTML: every string returned here is rendered as a text node.
// Unit-tested in test/unit/web-model.test.js.

import { DASH, clampPct, clockTime, formatPercent, formatValue, isMissing, parseTime, relativeTime, shortSpan } from "./format.js";

/** @typedef {"error" | "warning" | "info"} Severity */
/** @typedef {{ startLine: number, lines: string[], markLine: number }} Excerpt */
/** @typedef {{ severity: Severity, file: string, line?: number, col?: number, code: string, message: string, tileId?: string, excerpt?: Excerpt }} Problem */
/** @typedef {{ key: string, label: string, format: import("./format.js").FieldFormat }} Field */
/** @typedef {{ type: string, supported: boolean, hideErrors: boolean, fields: Field[], nowPlaying: boolean }} Widget */
/** @typedef {{ kind: "img", src: string, mono: boolean } | { kind: "letter", letter: string }} Icon */
/** @typedef {{ id: string, name: string, description?: string, href?: string, icon: Icon, check: "http" | "ping" | "none", widget?: Widget }} Tile */
/** @typedef {{ id: string, name: string, columns?: number, collapsed: boolean, groups: Group[], tiles: Tile[] }} Group */
/** @typedef {{ hideNoCheck: boolean, groupsInitiallyCollapsed: boolean, disableCollapse: boolean, statusIntervalS: number, widgetIntervalS: number }} Settings */
/** @typedef {{ rev: number, title: string, theme: "auto" | "light" | "dark", configPath: string, sampleInUse: boolean, loadedAt: string, error?: Problem, usingLastGood: boolean, settings: Settings, groups: Group[], problems: Problem[] }} Config */
/** @typedef {{ state: "up" | "down" | "unknown", kind: "http" | "ping", httpStatus?: number, latencyMs?: number, reason?: string, host?: string, detail?: string, checkedAt?: string, downSince?: string }} Status */
/** @typedef {{ title?: unknown, subtitle?: unknown, user?: unknown, progressPct?: unknown, paused?: unknown }} NowPlayingItem */
/** @typedef {{ kind?: string, host?: string, httpStatus?: number, timeoutS?: number, message?: string }} WidgetError */
/** @typedef {{ state: "loading" | "ok" | "error" | "unsupported", values?: Record<string, unknown>, nowPlaying?: NowPlayingItem[], error?: WidgetError, updatedAt?: string, lastOkAt?: string }} WidgetResult */
/** @typedef {{ rev: number, now: string, refreshing: boolean, status: Record<string, Status>, widgets: Record<string, WidgetResult> }} Snapshot */
/**
 * View context. `now` is the SERVER's clock (browser time + the offset measured
 * from StateSnapshot.now) and is compared with server timestamps (checkedAt,
 * downSince, lastOkAt). `clientNow` is the browser's clock, compared with
 * lastPollAt (also browser time). clientNow defaults to now (no skew).
 * @typedef {{ settings: Settings, now: number, clientNow?: number, backendStale: boolean, lastPollAt: number, locale?: string }} ViewCtx
 */

/** Browser-clock "now" of a context. @param {ViewCtx} ctx */
export function clientNowOf(ctx) {
  return typeof ctx.clientNow === "number" ? ctx.clientNow : ctx.now;
}

/** Convert a server timestamp to the browser's clock for wall-clock display. @param {number} t @param {ViewCtx} ctx */
export function toClientTime(t, ctx) {
  return t - (ctx.now - clientNowOf(ctx));
}

/**
 * Offset of the server clock from the browser clock, from a snapshot's `now`.
 * 0 when unknown. @param {string} serverNowIso @param {number} clientNow
 */
export function clockSkew(serverNowIso, clientNow) {
  const t = parseTime(serverNowIso);
  return Number.isFinite(t) ? t - clientNow : 0;
}

/** Browser poll interval for api/state (design §4.4). */
export const POLL_MS = 5000;
/** The header turns stale after 3 missed polls (UX §3.3). */
export const BACKEND_STALE_MS = 3 * POLL_MS;
/** Max tiles' stat cells (UX §4.1). */
export const MAX_FIELDS = 4;
/** Now playing: rows always reserved (UX §14.3). */
export const NOW_PLAYING_ROWS = 2;

/**
 * Docs links (UX §9, C-23). Anchors follow GitHub's heading slugs in
 * homelab/DOCS.md; WS7 owns those headings.
 */
const DOCS = "https://github.com/zaydons/ha-repository/blob/main/homelab/DOCS.md";
export const DOCS_LINKS = Object.freeze({
  configErrors: { href: `${DOCS}#fixing-config-errors`, text: "How to fix config errors" },
  setup: { href: `${DOCS}#setup`, text: "Read the setup guide" },
  widgets: { href: `${DOCS}#supported-widgets`, text: "Supported widgets" },
});

// ---------------------------------------------------------------------------
// Trust-boundary sanitising of api/config (threat model R2, R3)
// ---------------------------------------------------------------------------

/**
 * http(s) only, parsed with URL; anything else = no link (non-link tile).
 * @param {unknown} href @returns {string | undefined}
 */
export function safeHref(href) {
  if (typeof href !== "string" || href.length > 2048) return undefined;
  let u;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username || u.password) return undefined;
  return u.href;
}

/** Relative icon route served by this app (never a leading slash; ingress-relative). */
const PROXIED_ICON_RE = /^icons\/(mdi|si|di|sh|local)\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}(\?c=[0-9A-Fa-f]{6})?$/;

/**
 * IconRef -> Icon. `proxied` must be a relative `icons/...` path, `url` must be
 * http(s); everything else becomes the letter fallback.
 * @param {unknown} ref @param {string} name @returns {Icon}
 */
export function safeIcon(ref, name) {
  const letter = { kind: /** @type {const} */ ("letter"), letter: firstLetter(name) };
  if (!ref || typeof ref !== "object") return letter;
  const r = /** @type {Record<string, unknown>} */ (ref);
  if (r.kind === "proxied" && typeof r.src === "string" && PROXIED_ICON_RE.test(r.src)) {
    // mdi and si SVGs are single-colour (black) glyphs: the UI tints them for
    // the theme unless the config pinned a colour (?c=rrggbb).
    const mono = /^icons\/(mdi|si)\//.test(r.src) && !r.src.includes("?c=");
    return { kind: "img", src: r.src, mono };
  }
  if (r.kind === "url") {
    const src = safeHref(r.src);
    if (src) return { kind: "img", src, mono: false };
  }
  if (r.kind === "letter" && typeof r.letter === "string" && r.letter.trim()) {
    return { kind: "letter", letter: firstLetter(r.letter) };
  }
  return letter;
}

/** @param {string} s */
function firstLetter(s) {
  const ch = Array.from(String(s).trim())[0];
  return ch ? ch.toLocaleUpperCase() : "?";
}

/** @param {unknown} v @param {string} [fallback] */
const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);
/** @param {unknown} v @param {number} fallback */
const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
/** @param {unknown} v */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v @returns {Record<string, unknown>} */
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {});

const FORMATS = new Set(["number", "bytes", "byterate", "duration", "percent", "text"]);
const SEVERITIES = new Set(["error", "warning", "info"]);

/** @param {unknown} raw @returns {Problem | undefined} */
function sanitizeProblem(raw) {
  const p = obj(raw);
  if (typeof p.message !== "string") return undefined;
  /** @type {Problem} */
  const out = {
    severity: SEVERITIES.has(/** @type {string} */ (p.severity)) ? /** @type {Severity} */ (p.severity) : "warning",
    file: str(p.file, "services.yaml"),
    code: str(p.code),
    message: p.message,
  };
  if (typeof p.line === "number") out.line = p.line;
  if (typeof p.col === "number") out.col = p.col;
  if (typeof p.tileId === "string") out.tileId = p.tileId;
  const ex = obj(p.excerpt);
  if (Array.isArray(ex.lines) && typeof ex.startLine === "number") {
    out.excerpt = {
      startLine: ex.startLine,
      lines: ex.lines.slice(0, 20).map((l) => str(l)),
      markLine: num(ex.markLine, ex.startLine),
    };
  }
  return out;
}

/** @param {unknown} raw @returns {Tile | undefined} */
function sanitizeTile(raw) {
  const t = obj(raw);
  if (typeof t.id !== "string" || typeof t.name !== "string") return undefined;
  /** @type {Tile} */
  const tile = {
    id: t.id,
    name: t.name,
    icon: safeIcon(t.icon, t.name),
    check: t.check === "http" || t.check === "ping" ? t.check : "none",
  };
  if (typeof t.description === "string" && t.description) tile.description = t.description;
  const href = safeHref(t.href);
  if (href) tile.href = href;
  if (t.widget && typeof t.widget === "object") {
    const w = obj(t.widget);
    tile.widget = {
      type: str(w.type, "unknown"),
      supported: w.supported === true,
      hideErrors: w.hideErrors === true,
      nowPlaying: w.nowPlaying === true,
      fields: arr(w.fields)
        .map((f) => obj(f))
        .filter((f) => typeof f.key === "string")
        .slice(0, MAX_FIELDS)
        .map((f) => ({
          key: /** @type {string} */ (f.key),
          label: str(f.label, /** @type {string} */ (f.key)),
          format: FORMATS.has(/** @type {string} */ (f.format))
            ? /** @type {import("./format.js").FieldFormat} */ (f.format)
            : "number",
        })),
    };
  }
  return tile;
}

/** @param {unknown} raw @param {number} depth @returns {Group | undefined} */
function sanitizeGroup(raw, depth) {
  const g = obj(raw);
  if (typeof g.id !== "string" || typeof g.name !== "string") return undefined;
  const tiles = /** @type {Tile[]} */ (arr(g.tiles).map(sanitizeTile).filter(Boolean));
  let groups = /** @type {Group[]} */ (arr(g.groups).map((x) => sanitizeGroup(x, depth + 1)).filter(Boolean));
  if (depth >= 1) {
    // One nesting level is rendered; deeper levels are flattened (UX §3.2).
    for (const sub of groups) tiles.push(...flattenTiles([sub]));
    groups = [];
  }
  /** @type {Group} */
  const out = { id: g.id, name: g.name, collapsed: g.collapsed === true, groups, tiles };
  const cols = num(g.columns, 0);
  if (Number.isInteger(cols) && cols >= 1 && cols <= 12) out.columns = cols;
  return out;
}

/**
 * Validate and normalise api/config. Throws when the shape is unusable.
 * @param {unknown} raw @returns {Config}
 */
export function sanitizeConfig(raw) {
  const c = obj(raw);
  if (typeof c.rev !== "number" || !Array.isArray(c.groups)) throw new Error("Unexpected api/config response");
  const s = obj(c.settings);
  /** @type {Config} */
  const cfg = {
    rev: c.rev,
    title: str(c.title, "Homelab") || "Homelab",
    theme: c.theme === "light" || c.theme === "dark" ? c.theme : "auto",
    configPath: str(c.configPath),
    sampleInUse: c.sampleInUse === true,
    loadedAt: str(c.loadedAt),
    usingLastGood: c.usingLastGood === true,
    settings: {
      hideNoCheck: s.hideNoCheck === true,
      groupsInitiallyCollapsed: s.groupsInitiallyCollapsed === true,
      disableCollapse: s.disableCollapse === true,
      statusIntervalS: Math.max(1, num(s.statusIntervalS, 30)),
      widgetIntervalS: Math.max(1, num(s.widgetIntervalS, 30)),
    },
    groups: /** @type {Group[]} */ (c.groups.map((g) => sanitizeGroup(g, 0)).filter(Boolean)),
    problems: /** @type {Problem[]} */ (arr(c.problems).map(sanitizeProblem).filter(Boolean)),
  };
  const err = c.error ? sanitizeProblem(c.error) : undefined;
  if (err) cfg.error = err;
  return cfg;
}

/**
 * Validate api/state. Throws when the shape is unusable.
 * @param {unknown} raw @returns {Snapshot}
 */
export function sanitizeState(raw) {
  const s = obj(raw);
  if (typeof s.rev !== "number") throw new Error("Unexpected api/state response");
  return {
    rev: s.rev,
    now: str(s.now),
    refreshing: s.refreshing === true,
    status: /** @type {Record<string, Status>} */ (obj(s.status)),
    widgets: /** @type {Record<string, WidgetResult>} */ (obj(s.widgets)),
  };
}

/** @template T @param {Record<string, T> | undefined} map @param {string} key @returns {T | undefined} */
export function lookup(map, key) {
  if (!map || !Object.hasOwn(map, key)) return undefined;
  const v = map[key];
  return v && typeof v === "object" ? v : undefined;
}

/** @param {Group[]} groups @returns {Tile[]} */
export function flattenTiles(groups) {
  /** @type {Tile[]} */
  const out = [];
  for (const g of groups) {
    out.push(...g.tiles);
    out.push(...flattenTiles(g.groups));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status pill (UX §5.1, §5.2)
// ---------------------------------------------------------------------------

const HTTP_TEXT = /** @type {Record<number, string>} */ ({
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  408: "Request Timeout", 429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented",
  502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
});

/**
 * @typedef {{ kind: "hidden" | "loading" | "up" | "down" | "nocheck" | "unknown", word: string,
 *   tooltip: string, inline: string | null, stale: boolean }} StatusView
 */

/**
 * @param {Status} st @param {string | undefined} locale
 * @returns {{ full: string, short: string, checked: boolean }}
 */
export function downReason(st, locale) {
  const host = st.host || "the host";
  switch (st.reason) {
    case "http": {
      const code = num(st.httpStatus, 0);
      const text = HTTP_TEXT[code];
      return code
        ? { full: `HTTP ${code}${text ? ` ${text}` : ""}`, short: `HTTP ${code}`, checked: true }
        : { full: "Unexpected HTTP response", short: "HTTP error", checked: true };
    }
    case "timeout":
      return { full: "No response within 5 s", short: "No response", checked: true };
    case "refused":
      return { full: "Connection refused (is the service running?)", short: "Connection refused", checked: true };
    case "dns":
      return { full: `Can't resolve hostname ${host}`, short: "DNS lookup failed", checked: true };
    case "tls":
      return {
        full: `TLS certificate error: ${st.detail || "unknown error"}. Set tlsVerify: false if it's self-signed.`,
        short: "TLS certificate error",
        checked: false,
      };
    case "ping":
      return { full: `No ping reply from ${host}`, short: "No ping reply", checked: true };
    case "unreachable":
      return { full: `Can't reach ${host}`, short: "Unreachable", checked: true };
    default:
      void locale;
      return { full: "Not responding", short: "Not responding", checked: true };
  }
}

/**
 * @param {Tile} tile @param {Status | undefined} st @param {ViewCtx} ctx
 * @returns {StatusView}
 */
export function statusView(tile, st, ctx) {
  const { locale, now } = ctx;
  if (tile.check === "none") {
    if (ctx.settings.hideNoCheck) return { kind: "hidden", word: "", tooltip: "", inline: null, stale: false };
    return {
      kind: "nocheck",
      word: "No check",
      tooltip: "No status check set up for this service. Add siteMonitor: or ping: to enable it.",
      inline: null,
      stale: false,
    };
  }
  if (!st || (st.state !== "up" && st.state !== "down" && st.state !== "unknown")) {
    return { kind: "loading", word: "Checking status", tooltip: "Checking…", inline: null, stale: false };
  }
  const checkedAt = parseTime(st.checkedAt);
  const ago = Number.isFinite(checkedAt) ? `checked ${relativeTime(now - checkedAt, locale)}` : "";
  /** @type {StatusView} */
  let view;
  if (st.state === "up") {
    const parts = ["Up"];
    const lat = typeof st.latencyMs === "number" && Number.isFinite(st.latencyMs) ? `${Math.round(st.latencyMs)} ms` : "";
    if (st.kind === "ping") parts.push(lat ? `ping ${lat}` : "ping");
    else {
      if (typeof st.httpStatus === "number") parts.push(`HTTP ${st.httpStatus}`);
      if (lat) parts.push(lat);
    }
    if (ago) parts.push(ago);
    view = { kind: "up", word: "Up", tooltip: parts.join(" · "), inline: null, stale: false };
  } else if (st.state === "down") {
    const r = downReason(st, locale);
    let tooltip = `Down · ${r.full}${r.checked && ago ? ` · ${ago}` : ""}`;
    const since = parseTime(st.downSince);
    if (Number.isFinite(since)) {
      tooltip += `\nDown since ${clockTime(toClientTime(since, ctx), locale)} (${shortSpan(now - since, locale)})`;
    }
    // Shown in the description slot on every down tile (UX L7), so phones see why.
    const inline = `${r.short}${Number.isFinite(checkedAt) ? ` · ${relativeTime(now - checkedAt, locale)}` : ""}`;
    view = { kind: "down", word: "Down", tooltip, inline, stale: false };
  } else {
    const reason = errnoText(st.detail);
    view = {
      kind: "unknown",
      word: "Unknown",
      tooltip: `Couldn't run the check: ${reason}. Will retry in ${ctx.settings.statusIntervalS} s.`,
      inline: null,
      stale: false,
    };
  }
  if (ctx.backendStale) {
    const firstLine = view.tooltip.split("\n")[0]?.split(" · ")[0] ?? view.word;
    view = {
      ...view,
      stale: true,
      tooltip: ctx.lastPollAt
        ? `Last known: ${firstLine} · ${relativeTime(clientNowOf(ctx) - ctx.lastPollAt, locale)}. Can't reach the dashboard backend.`
        : "Can't reach the dashboard backend.",
    };
  }
  return view;
}

const ERRNO = /** @type {Record<string, string>} */ ({
  EPERM: "permission denied", EACCES: "permission denied", ENOENT: "ping isn't installed", ENOMEM: "out of memory",
  EMFILE: "too many open files", ENFILE: "too many open files", EAGAIN: "temporarily unavailable", ETIMEDOUT: "timed out",
});

/** "permission denied (EPERM)" for an errno-style detail; plain text passes through. @param {string | undefined} detail */
export function errnoText(detail) {
  if (!detail) return "internal error";
  const known = ERRNO[detail];
  return known ? `${known} (${detail})` : detail;
}

// ---------------------------------------------------------------------------
// Stats area (UX §5.3)
// ---------------------------------------------------------------------------

/**
 * `text`: the value is free text from upstream (any length), so it may
 * ellipsize; formatted numbers are short by construction and never do (F-2).
 * @typedef {{ label: string, value: string, missing: boolean, title: string, text: boolean }} Cell
 * @typedef {{ kind: "none" | "unsupported" | "loading" | "ok" | "stale" | "error" | "muted",
 *   cells: Cell[], message: string, detail: string, staleText: string, staleTitle: string,
 *   countsAsIssue: boolean, sr: string }} WidgetView
 */

const TRANSIENT = new Set(["timeout", "unreachable"]);

/**
 * User-facing error copy for a widget error (C-10). May contain `code` spans.
 * @param {Tile} tile @param {WidgetError} err @param {Settings} settings
 */
export function widgetErrorText(tile, err, settings) {
  const name = tile.name;
  switch (err.kind) {
    case "auth": {
      const msg =
        tile.widget?.type === "immich" && err.httpStatus === 403
          ? "Sign-in failed. The Immich API key needs the `server.statistics` permission."
          : `Sign-in failed. Check the API key/username for ${name} in services.yaml.`;
      return { message: msg, detail: err.httpStatus ? `HTTP ${err.httpStatus}` : "" };
    }
    case "unreachable":
      return {
        message: err.host ? `Can't reach ${name} at ${err.host}. Check the widget \`url\`.` : `Can't reach ${name}. Check the widget \`url\`.`,
        detail: "",
      };
    case "timeout":
      return {
        message: `${name} didn't answer within ${num(err.timeoutS, 10)} s. Retrying in ${settings.widgetIntervalS} s.`,
        detail: "",
      };
    case "bad_response":
      return {
        message: `${name} sent a response we couldn't read. Its API version may not be supported.`,
        detail: err.httpStatus ? `HTTP ${err.httpStatus}` : "",
      };
    case "config":
      return { message: err.message || `${name} widget has a config problem. See the problems list.`, detail: "" };
    default:
      return { message: `${name} stats aren't available right now.`, detail: "" };
  }
}

/**
 * @param {Tile} tile @param {WidgetResult | undefined} res @param {ViewCtx} ctx
 * @returns {WidgetView}
 */
export function widgetView(tile, res, ctx) {
  /** @type {WidgetView} */
  const base = { kind: "none", cells: [], message: "", detail: "", staleText: "", staleTitle: "", countsAsIssue: false, sr: "" };
  const w = tile.widget;
  if (!w) return base;
  if (!w.supported || res?.state === "unsupported") {
    const message = `The "${w.type}" widget isn't supported yet. This tile still works as a link.`;
    return { ...base, kind: "unsupported", message, sr: message };
  }
  const labels = w.fields.map((f) => f.label);
  if (!res || res.state === "loading" || (res.state !== "ok" && res.state !== "error")) {
    return {
      ...base,
      kind: "loading",
      cells: w.fields.map((f) => ({ label: f.label, value: "", missing: false, title: "", text: false })),
      sr: `Loading ${tile.name} stats`,
    };
  }
  /** @param {Record<string, unknown>} values */
  const cellsFrom = (values) =>
    w.fields.map((f) => {
      const v = Object.hasOwn(values, f.key) ? values[f.key] : null;
      const missing = isMissing(v);
      return {
        label: f.label,
        value: missing ? DASH : formatValue(v, f.format, ctx.locale),
        missing,
        title: missing ? `Not reported by ${tile.name}` : "",
        text: !missing && typeof v === "string",
      };
    });
  /** @param {Cell[]} cells */
  const srCells = (cells) => cells.map((c, i) => `${labels[i]} ${c.missing ? "not reported" : c.value}`).join(", ");

  if (res.state === "ok") {
    const cells = cellsFrom(obj(res.values));
    if (ctx.backendStale && ctx.lastPollAt) {
      // The browser can't reach the backend: these values are old too (UX §5.3, review F7).
      const at = clockTime(ctx.lastPollAt, ctx.locale);
      return {
        ...base,
        kind: "stale",
        cells,
        staleText: relativeTime(clientNowOf(ctx) - ctx.lastPollAt, ctx.locale),
        staleTitle: `Can't reach the dashboard backend. Showing values from ${at}.`,
        sr: `${srCells(cells)}. Showing values from ${at}`,
      };
    }
    return { ...base, kind: "ok", cells, sr: srCells(cells) };
  }
  // state === "error"
  const err = /** @type {WidgetError} */ (obj(res.error));
  const lastOk = parseTime(res.lastOkAt);
  const windowMs = 3 * ctx.settings.widgetIntervalS * 1000;
  const values = res.values && typeof res.values === "object" ? obj(res.values) : null;
  if (values && TRANSIENT.has(String(err.kind)) && Number.isFinite(lastOk) && ctx.now - lastOk <= windowMs) {
    const cells = cellsFrom(values);
    const at = clockTime(toClientTime(lastOk, ctx), ctx.locale);
    return {
      ...base,
      kind: "stale",
      cells,
      staleText: relativeTime(ctx.now - lastOk, ctx.locale),
      staleTitle: `Couldn't refresh. Showing values from ${at}.`,
      sr: `${srCells(cells)}. Showing values from ${at}`,
    };
  }
  if (w.hideErrors) return { ...base, kind: "muted", message: DASH, sr: `${tile.name} stats not available` };
  const { message, detail } = widgetErrorText(tile, err, ctx.settings);
  return { ...base, kind: "error", message, detail, countsAsIssue: true, sr: stripTicks(message) };
}

/** Remove the backticks used for `code` spans (for titles and screen readers). */
export function stripTicks(/** @type {string} */ s) {
  return s.replace(/`/g, "");
}

/**
 * Split "text `code` text" into segments for rendering <code> as text nodes.
 * @param {string} s @returns {{ code: boolean, text: string }[]}
 */
export function codeSegments(s) {
  const parts = s.split("`");
  // Unbalanced ticks: render literally.
  if (parts.length % 2 === 0) return [{ code: false, text: s }];
  return parts.map((text, i) => ({ code: i % 2 === 1, text })).filter((p) => p.text !== "");
}

// ---------------------------------------------------------------------------
// Now playing (UX §14)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ title: string, paused: boolean, meta: string, metaShort: string, line2: string, pct: number | null }} NowRow
 * @typedef {{ kind: "none" | "loading" | "items" | "error", stale: boolean, rows: NowRow[],
 *   overflow: string, overflowTitle: string, empty: boolean, muted: boolean, message: string, sr: string }} NowPlayingView
 */

/**
 * @param {NowPlayingItem} it @param {string | undefined} locale @returns {NowRow & { srText: string }}
 */
function nowRow(it, locale) {
  const title = typeof it.title === "string" && it.title.trim() ? it.title : "Untitled";
  const paused = it.paused === true;
  const pct = clampPct(it.progressPct);
  const pctText = pct === null ? "" : formatPercent(pct, locale, 0);
  const meta = paused ? (pctText ? `Paused · ${pctText}` : "Paused") : pctText;
  const user = typeof it.user === "string" ? it.user.trim() : "";
  const sub = typeof it.subtitle === "string" ? it.subtitle.trim() : "";
  const line2 = [user, sub].filter(Boolean).join(" · ");
  const srParts = [title, sub, user].filter(Boolean);
  if (pct !== null) srParts.push(paused ? `paused at ${pct} percent` : `${pct} percent`);
  else if (paused) srParts.push("paused");
  return { title, paused, meta, metaShort: paused ? "Paused" : pctText, line2, pct, srText: srParts.join(", ") };
}

/**
 * @param {Tile} tile @param {WidgetResult | undefined} res @param {WidgetView} wv @param {string} [locale]
 * @returns {NowPlayingView}
 */
export function nowPlayingView(tile, res, wv, locale) {
  /** @type {NowPlayingView} */
  const base = { kind: "none", stale: false, rows: [], overflow: "", overflowTitle: "", empty: false, muted: false, message: "", sr: "" };
  if (!tile.widget?.nowPlaying || wv.kind === "unsupported" || wv.kind === "none") return base;
  if (wv.kind === "loading") return { ...base, kind: "loading", sr: "Loading now playing" };
  if (wv.kind === "error" || wv.kind === "muted") {
    // With no stats row (enableBlocks off) the list is the only place for the error (UX L8).
    const message = wv.kind === "error" && tile.widget.fields.length === 0 ? wv.message : "";
    return { ...base, kind: "error", muted: wv.kind === "muted", message, sr: "Now playing not available" };
  }
  const items = arr(res?.nowPlaying).filter((x) => x && typeof x === "object");
  const rows = items.map((it) => nowRow(/** @type {NowPlayingItem} */ (it), locale));
  const view = { ...base, kind: /** @type {const} */ ("items"), stale: wv.kind === "stale" };
  if (rows.length === 0) return { ...view, empty: true, sr: "Nothing playing" };
  const shown = rows.slice(0, NOW_PLAYING_ROWS).map(({ srText: _s, ...r }) => r);
  const hidden = rows.slice(NOW_PLAYING_ROWS);
  let overflow = "";
  let overflowTitle = "";
  if (hidden.length > 0) {
    overflow = `+${hidden.length} more`;
    const names = hidden.slice(0, 5).map((r) => r.title);
    overflowTitle = `Also playing: ${names.join(", ")}${hidden.length > 5 ? ` and ${hidden.length - 5} more` : ""}`;
  }
  const spoken = rows.slice(0, 10).map((r) => r.srText).join("; ");
  const more = rows.length > 10 ? `; and ${rows.length - 10} more` : "";
  const sr = `Now playing, ${rows.length} ${rows.length === 1 ? "stream" : "streams"}: ${spoken}${more}`;
  return { ...view, rows: shown, overflow, overflowTitle, sr };
}

// ---------------------------------------------------------------------------
// Health summaries (header, groups, live region)
// ---------------------------------------------------------------------------

/**
 * @param {Tile[]} tiles @param {Snapshot | null} snap @param {ViewCtx} ctx
 * @returns {{ down: Tile[], issues: Tile[], up: number }}
 */
export function health(tiles, snap, ctx) {
  /** @type {Tile[]} */ const down = [];
  /** @type {Tile[]} */ const issues = [];
  let up = 0;
  if (!snap) return { down, issues, up };
  for (const t of tiles) {
    const sv = statusView(t, lookup(snap.status, t.id), ctx);
    if (sv.kind === "down") down.push(t);
    else if (sv.kind === "up") up++;
    if (widgetView(t, lookup(snap.widgets, t.id), ctx).countsAsIssue) issues.push(t);
  }
  return { down, issues, up };
}

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * Header summary (C-01..C-03). null while the first poll is loading, and when
 * nothing has reported yet (no tile is up, down or failing): "All up" must be earned.
 * @param {{ down: Tile[], issues: Tile[], up: number }} h @param {boolean} loaded
 * @returns {{ tone: "ok" | "down" | "warn", text: string } | null}
 */
export function headerSummary(h, loaded) {
  if (!loaded) return null;
  if (h.down.length > 0) {
    const issues = h.issues.length ? ` · ${h.issues.length} ${plural(h.issues.length, "issue", "issues")}` : "";
    return { tone: "down", text: `${h.down.length} down${issues}` };
  }
  if (h.issues.length > 0) return { tone: "warn", text: `${h.issues.length} ${plural(h.issues.length, "issue", "issues")}` };
  return h.up > 0 ? { tone: "ok", text: "All up" } : null;
}

/**
 * Group header summary: visible "4 · 1 down" and SR "Infrastructure, 4 services, 1 down".
 * @param {Group} g @param {Set<string>} downIds @param {Set<string>} upIds
 */
export function groupSummary(g, downIds, upIds) {
  const tiles = flattenTiles([g]);
  const down = tiles.filter((t) => downIds.has(t.id)).length;
  const anyUp = tiles.some((t) => upIds.has(t.id));
  const n = tiles.length;
  let visible = String(n);
  let spoken = `${g.name}, ${n} ${plural(n, "service", "services")}`;
  if (down > 0) {
    visible += ` · ${down} down`;
    spoken += `, ${down} down`;
  } else if (anyUp) {
    visible += " · all up";
    spoken += ", all up";
  }
  return { visible, spoken, down };
}

/**
 * Health transitions between two snapshots (for the live region, UX §10).
 * Only up<->down changes are announced; the first snapshot announces nothing.
 * @param {Tile[]} tiles @param {Snapshot | null} prev @param {Snapshot} next
 */
export function healthChanges(tiles, prev, next) {
  /** @type {string[]} */ const down = [];
  /** @type {string[]} */ const up = [];
  if (!prev) return { down, up };
  for (const t of tiles) {
    const a = lookup(prev.status, t.id)?.state;
    const b = lookup(next.status, t.id)?.state;
    if (a === "up" && b === "down") down.push(t.name);
    else if (a === "down" && b === "up") up.push(t.name);
  }
  return { down, up };
}

/** @param {string[]} names */
function nameList(names) {
  if (names.length <= 1) return names.join("");
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/**
 * C-24 copy. Names are de-duplicated (a flap within the debounce window keeps the latest state).
 * @param {{ down: string[], up: string[] }} ch @returns {string}
 */
export function announcement(ch) {
  const parts = [];
  if (ch.down.length) parts.push(`${nameList(ch.down)} ${ch.down.length === 1 ? "is" : "are"} down`);
  if (ch.up.length) parts.push(`${nameList(ch.up)} ${ch.up.length === 1 ? "is" : "are"} back up`);
  return parts.join(". ");
}

// ---------------------------------------------------------------------------
// Config problems (UX §8)
// ---------------------------------------------------------------------------

/** @param {Problem} a @param {Problem | undefined} b */
function sameProblem(a, b) {
  return !!b && a.code === b.code && a.file === b.file && a.line === b.line && a.message === b.message;
}

/**
 * Problems for the list, the fatal error first, without duplicates.
 * @param {Config} cfg @returns {Problem[]}
 */
export function allProblems(cfg) {
  const rest = cfg.problems.filter((p) => !sameProblem(p, cfg.error));
  return cfg.error ? [cfg.error, ...rest] : rest;
}

/**
 * Count for the "{n} config warnings" chip: warnings and item errors, not info.
 * @param {Config} cfg
 */
export function warningCount(cfg) {
  return cfg.problems.filter((p) => p.severity !== "info" && !sameProblem(p, cfg.error)).length;
}

/**
 * Item problems shown on the tile itself (UX §8.1). Widget problems are
 * already shown by the widget state, so they're excluded here.
 * @param {Config} cfg @param {string} tileId @returns {Problem[]}
 */
export function tileProblems(cfg, tileId) {
  return cfg.problems.filter(
    (p) => p.tileId === tileId && p.severity !== "info" && !p.code.startsWith("widget."),
  );
}

/** "services.yaml line 22" for problem lists. @param {Problem} p */
export function problemLocation(p) {
  if (typeof p.line !== "number") return p.file;
  return `${p.file} line ${p.line}${typeof p.col === "number" ? `, column ${p.col}` : ""}`;
}

/**
 * Banner title (C-11): "Couldn't load services.yaml: line 14, column 5".
 * @param {Problem} p
 */
export function bannerTitle(p) {
  if (typeof p.line !== "number") return `Couldn't load ${p.file}`;
  return `Couldn't load ${p.file}: line ${p.line}${typeof p.col === "number" ? `, column ${p.col}` : ""}`;
}

/**
 * Toast after a config reload (C-13); null when nothing to say.
 * @param {Config | null} prev @param {Config} next
 * @returns {{ text: string, showProblems: boolean } | null}
 */
export function reloadToast(prev, next) {
  if (!prev || prev.rev === next.rev || next.error) return null;
  const n = warningCount(next);
  if (n > 0) return { text: `Config reloaded with ${n} ${plural(n, "warning", "warnings")}`, showProblems: true };
  return { text: "Config reloaded", showProblems: false };
}

/**
 * What the page body shows.
 * @param {Config} cfg @returns {"fatal" | "empty" | "dashboard"}
 */
export function pageMode(cfg) {
  const tiles = flattenTiles(cfg.groups).length;
  if (cfg.error && tiles === 0 && !cfg.usingLastGood) return "fatal";
  if (tiles === 0) return cfg.error ? "fatal" : "empty";
  return "dashboard";
}

/**
 * Tile accessible name (UX §10): "{Name}, {status word}, {description}, opens in new tab".
 * @param {Tile} tile @param {StatusView} sv
 */
export function tileLabel(tile, sv) {
  const parts = [tile.name];
  if (sv.kind === "loading") parts.push("checking status");
  else if (sv.kind !== "hidden") parts.push(sv.word);
  if (tile.description) parts.push(tile.description);
  return parts.join(", ") + (tile.href ? ", opens in new tab" : "");
}

/** Exposed for tests: the now-playing percent formatter is locale-aware. */
export const _internal = { nowRow, nameList };

/** "10:42" from an ISO time, "" when invalid. @param {string} iso @param {string} [locale] */
export function clockTimeOf(iso, locale) {
  const t = parseTime(iso);
  return Number.isFinite(t) ? clockTime(t, locale) : "";
}
