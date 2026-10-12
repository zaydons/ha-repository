// Server-side value helpers for widget plugins: read and coerce upstream API
// values into WidgetValue (number | string | null). Display formatting (units,
// locale) is the frontend's job (web/format.js); plugins return raw numbers in
// base units (bytes, bytes/s, seconds).
//
// Convention (design §4.5): a missing *optional* value is null; a response of
// the wrong shape is a WidgetError("bad_response").
import { WidgetError } from "../types.ts";
import type { WidgetValue } from "../types.ts";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Finite number, or a numeric string; anything else is null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Plain string (trimmed, capped), or null. Numbers are stringified. */
export function toText(v: unknown, maxLen = 200): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s.slice(0, maxLen);
}

/** Rounds to `dp` decimal places; null stays null. */
export function round(v: number | null, dp = 0): number | null {
  if (v === null) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** The value must be an object, else bad_response naming `what` (an endpoint, not a URL). */
export function expectRecord(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new WidgetError("bad_response", `${what}: expected an object`);
  return v;
}

/** The value must be an array, else bad_response. */
export function expectArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new WidgetError("bad_response", `${what}: expected a list`);
  return v;
}

/**
 * Sums a numeric property over a list. Items without the property count as 0;
 * if no item has it (or the list is empty and `nullIfNone`), returns null.
 */
export function sumOf(list: readonly unknown[], key: string, nullIfNone = false): number | null {
  let sum = 0;
  let seen = 0;
  for (const item of list) {
    if (!isRecord(item)) continue;
    const n = toNumber(item[key]);
    if (n === null) continue;
    sum += n;
    seen++;
  }
  if (seen === 0 && (nullIfNone || list.length > 0)) return null;
  return sum;
}

/** Counts list items matching a predicate. Non-object items never match. */
export function countWhere(list: readonly unknown[], pred: (item: Record<string, unknown>) => boolean): number {
  let n = 0;
  for (const item of list) if (isRecord(item) && pred(item)) n++;
  return n;
}

const SIZE_UNITS: Record<string, number> = { "": 0, B: 0, K: 1, M: 2, G: 3, T: 4, P: 5 };

/**
 * Parses a human size such as "1.2 M", "512K", "3.4 GB", "800 B" into a byte
 * count (base 1024, as SABnzbd reports). Returns null when unparseable.
 */
export function parseSize(v: unknown, base = 1024): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?)(?:i?B)?(?:\/s)?\s*$/i.exec(v);
  if (!m) return null;
  const exp = SIZE_UNITS[(m[2] ?? "").toUpperCase()];
  if (exp === undefined) return null;
  return Number(m[1]) * base ** exp;
}

/** Parses "[d:]hh:mm:ss" or "mm:ss" into seconds. Returns null when unparseable. */
export function parseClock(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const parts = v.trim().split(":");
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  const mult = [1, 60, 3600, 86400];
  let total = 0;
  for (let i = 0; i < nums.length; i++) total += (nums[nums.length - 1 - i] ?? 0) * (mult[i] ?? 0);
  return total;
}

/** Keeps only the requested fields; fields without a value become null. */
export function pickFields(values: Record<string, WidgetValue | undefined>, fields: readonly string[]): Record<string, WidgetValue> {
  const out: Record<string, WidgetValue> = {};
  for (const f of fields) out[f] = values[f] ?? null;
  return out;
}

/** True if any of `keys` is among the requested fields. */
export function wants(fields: readonly string[], ...keys: string[]): boolean {
  return keys.some((k) => fields.includes(k));
}
