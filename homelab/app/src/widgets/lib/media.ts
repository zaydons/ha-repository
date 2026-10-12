// Small helpers shared by the media widget plugins (plex, jellyfin,
// audiobookshelf, immich). Upstream strings are data: they leave the plugin as
// plain, length-capped text and are rendered as text nodes by the frontend.
import { WidgetError } from "../types.ts";
import type { WidgetConfig } from "../types.ts";

/**
 * Reads a boolean config flag. YAML gives real booleans; "true"/"false"
 * strings are accepted too (Homepage configs sometimes quote them).
 */
export function flag(v: unknown, dflt: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return dflt;
}

/** Message for validate() when a flag isn't a boolean, else null. */
export function checkFlags(cfg: WidgetConfig, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = cfg[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") continue;
    if (typeof v === "string" && /^(true|false)$/i.test(v.trim())) continue;
    return `\`${k}\` must be true or false`;
  }
  return null;
}

/**
 * Parses the Homepage `version:` key. Returns the version, or null when the
 * value is present but not one of `allowed`. Absent = `dflt`.
 */
export function parseVersion(v: unknown, allowed: readonly number[], dflt: number): number | null {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return allowed.includes(n) ? n : null;
}

// C0/C1 controls and bidi embedding/override/isolate characters: they can
// visually reorder or hide surrounding text, so they never leave the plugin.
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Display text from an upstream value: string or finite number, cleaned, capped. Else null. */
export function plainText(v: unknown, maxLen = 200): string | null {
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" && Number.isFinite(v)) s = String(v);
  else return null;
  s = s.replace(UNSAFE_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  if (s === "") return null;
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An upstream id that will be placed in a request path. Only plain
 * alphanumeric ids are accepted, so upstream data can never add path segments
 * or a query. Returns null for anything else (the caller skips that item).
 */
export function safeId(v: unknown): string | null {
  const s = typeof v === "number" && Number.isInteger(v) && v >= 0 ? String(v) : v;
  return typeof s === "string" && SAFE_ID_RE.test(s) ? s : null;
}

/** The widget's credential as a header-safe string; config error if unusable. */
export function credential(cfg: WidgetConfig, key = "key"): string {
  const v = cfg[key];
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (s === "") throw new WidgetError("config", `needs \`${key}:\``);
  if (/[\u0000-\u001f\u007f"\\]/.test(s)) throw new WidgetError("config", `\`${key}\` contains characters that can't be sent`);
  return s;
}

/** validate() helper: the same rule as credential(), as a message. */
export function checkCredential(cfg: WidgetConfig, key = "key"): string | null {
  try {
    credential(cfg, key);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Runs `fn` over items with at most `limit` in flight; keeps order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
