// @ts-check
// Locale-aware number, size, duration and time formatting (UX §4.1, §10, §14.2).
// Pure functions, no DOM: unit-tested in test/unit/web-format.test.js.

/** @typedef {"number" | "bytes" | "byterate" | "duration" | "percent" | "text"} FieldFormat */

export const DASH = "—";

/** Browser locale, or undefined (= runtime default) outside a browser. */
export function defaultLocale() {
  return typeof navigator !== "undefined" && navigator.language ? navigator.language : undefined;
}

/** @type {Map<string, Intl.NumberFormat>} */
const nfCache = new Map();
/**
 * @param {string | undefined} locale
 * @param {Intl.NumberFormatOptions} opts
 */
function nf(locale, opts) {
  const key = `${locale ?? ""}|${JSON.stringify(opts)}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    nfCache.set(key, f);
  }
  return f;
}

/**
 * Plain numbers: up to 2 decimals below 10 000 (TrueNAS load "0.42"),
 * compact above ("41.2K").
 * @param {number} n @param {string} [locale]
 */
export function formatNumber(n, locale = defaultLocale()) {
  if (Math.abs(n) >= 10_000) return nf(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return nf(locale, { maximumFractionDigits: 2 }).format(n);
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "petabyte"];

/**
 * Bytes, base 1024, locale unit labels ("6.1 GB").
 * @param {number} n @param {string} [locale] @param {boolean} [perSecond]
 */
export function formatBytes(n, locale = defaultLocale(), perSecond = false) {
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${nf(locale, { maximumFractionDigits: 0 }).format(n)} B${perSecond ? "/s" : ""}`;
  const unit = BYTE_UNITS[i] + (perSecond ? "-per-second" : "");
  const digits = v >= 100 ? 0 : 1;
  return nf(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: digits }).format(
    Math.sign(n) * v,
  );
}

/**
 * Seconds to a short duration: "33d 8h", "3h 20m", "12m", "45s".
 * @param {number} seconds @param {string} [locale]
 */
export function formatDuration(seconds, locale = defaultLocale()) {
  const s = Math.max(0, Math.floor(seconds));
  const u = (/** @type {string} */ unit, /** @type {number} */ v) =>
    nf(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(v);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${u("day", d)} ${u("hour", h)}` : u("day", d);
  if (h > 0) return m > 0 ? `${u("hour", h)} ${u("minute", m)}` : u("hour", h);
  if (m > 0) return u("minute", m);
  return u("second", s);
}

/**
 * 0..100 value to a locale percent ("14.8%").
 * @param {number} pct @param {string} [locale] @param {number} [maxDigits]
 */
export function formatPercent(pct, locale = defaultLocale(), maxDigits = 1) {
  return nf(locale, { style: "percent", maximumFractionDigits: maxDigits }).format(pct / 100);
}

/**
 * Format one widget value for a stat cell. null/undefined/non-finite = "—".
 * A string for a numeric format is shown as text (plugins may pre-format).
 * @param {unknown} value @param {FieldFormat} format @param {string} [locale]
 * @returns {string}
 */
export function formatValue(value, format, locale = defaultLocale()) {
  if (value === null || value === undefined) return DASH;
  if (typeof value === "string") return value === "" ? DASH : value;
  if (typeof value !== "number" || !Number.isFinite(value)) return DASH;
  switch (format) {
    case "bytes":
      return formatBytes(value, locale);
    case "byterate":
      return formatBytes(value, locale, true);
    case "duration":
      return formatDuration(value, locale);
    case "percent":
      return formatPercent(value, locale);
    case "text":
      return String(value);
    case "number":
    default:
      return formatNumber(value, locale);
  }
}

/** True when a value counts as "not reported" (shows "—" with a tooltip). */
export function isMissing(/** @type {unknown} */ value) {
  if (value === null || value === undefined || value === "") return true;
  return typeof value === "number" && !Number.isFinite(value);
}

/** Clamp 0..100 and round; null when not a finite number. */
export function clampPct(/** @type {unknown} */ value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/** @type {Map<string, Intl.RelativeTimeFormat>} */
const rtfCache = new Map();

/**
 * "8s ago", "2m ago", "3h ago" (narrow, locale-aware). Under 10 s: "just now".
 * @param {number} ageMs @param {string} [locale]
 */
export function relativeTime(ageMs, locale = defaultLocale()) {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 10) return "just now";
  const key = locale ?? "";
  let rtf = rtfCache.get(key);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric: "always" });
    rtfCache.set(key, rtf);
  }
  if (s < 60) return rtf.format(-s, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.floor(m / 60);
  if (h < 48) return rtf.format(-h, "hour");
  return rtf.format(-Math.floor(h / 24), "day");
}

/**
 * Short duration for "Down since 10:41 (14 min)".
 * @param {number} ms @param {string} [locale]
 */
export function shortSpan(ms, locale = defaultLocale()) {
  return formatDuration(Math.max(60, ms / 1000), locale);
}

/**
 * Wall-clock time "10:42" in the browser locale.
 * @param {number} ms @param {string} [locale]
 */
export function clockTime(ms, locale = defaultLocale()) {
  return new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/**
 * Full date-time for title attributes.
 * @param {number} ms @param {string} [locale]
 */
export function absoluteTime(ms, locale = defaultLocale()) {
  return new Date(ms).toLocaleString(locale);
}

/** Parse an ISO time; NaN when absent or invalid. */
export function parseTime(/** @type {unknown} */ iso) {
  return typeof iso === "string" ? Date.parse(iso) : NaN;
}
