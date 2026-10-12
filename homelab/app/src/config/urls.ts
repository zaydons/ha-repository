// URL and name checks shared by the validator and the projection (threat model R2/R3).
import type { IconRef } from "../types.ts";

export type Scheme = "http:" | "https:" | "ws:" | "wss:";

export interface CheckedUrl {
  url: URL;
  /** Userinfo was present (user:pass@). */
  hadUserinfo: boolean;
}

/** Parse an absolute URL and require one of the schemes and a host. */
export function checkUrl(text: string, schemes: readonly Scheme[] = ["http:", "https:"]): CheckedUrl | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 2048) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!(schemes as readonly string[]).includes(url.protocol)) return null;
  if (!url.hostname) return null;
  return { url, hadUserinfo: url.username !== "" || url.password !== "" };
}

/** The URL without user:pass@ (for anything that reaches the browser). */
export function withoutUserinfo(url: URL): string {
  const u = new URL(url.href);
  u.username = "";
  u.password = "";
  return u.href;
}

/** Credentials that may be embedded in a URL: userinfo and secret-looking query params. */
export function urlSecrets(url: URL): string[] {
  const out: string[] = [];
  if (url.username) {
    out.push(url.username);
    try {
      out.push(decodeURIComponent(url.username));
    } catch {
      /* raw form already added */
    }
  }
  if (url.password) {
    out.push(url.password);
    try {
      out.push(decodeURIComponent(url.password));
    } catch {
      /* raw form already added */
    }
  }
  for (const [k, v] of url.searchParams) {
    if (/^(api_?key|key|token|x-plex-token|access_token|password|pass|auth)$/i.test(k) && v) out.push(v);
  }
  return [...new Set(out)];
}

const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*\.?$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^[0-9A-Fa-f:.]{2,45}(?:%[A-Za-z0-9_.-]{1,32})?$/;

/** A ping target: hostname, IPv4 or IPv6 (brackets allowed). Never starts with "-". Returns the bare host. */
export function checkPingHost(text: string): string | null {
  if (typeof text !== "string") return null;
  let h = text.trim();
  // Homepage users sometimes write a URL here; take its host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) {
    const c = checkUrl(h);
    if (!c) return null;
    h = c.url.hostname;
  }
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.startsWith("-") || h.length === 0) return null;
  if (IPV4_RE.test(h)) return h;
  if (h.includes(":")) return IPV6_RE.test(h) && /:/.test(h) ? h : null;
  return HOSTNAME_RE.test(h) ? h : null;
}

/**
 * Homepage icon strings we pass to the icon service: a bundled/CDN name
 * ("mdi-x", "si-x-#ff0000", "sh-x.png", "x.svg"), a local "/icons/..." path,
 * or an absolute http(s) URL (checked separately).
 */
export const ICON_NAME_RE = /^(?:\/icons\/(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\/){0,3})?[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(?:-#[0-9A-Fa-f]{3,8})?$/;

export function isIconName(s: string): boolean {
  return ICON_NAME_RE.test(s) && !s.includes("..");
}

const PROXIED_RE = /^icons\/[a-z]+\/[A-Za-z0-9._\/%-]{1,300}(?:\?[A-Za-z0-9=&%._-]{0,100})?$/;

/** Enforce threat-model R3 on whatever the icon service returned. */
export function sanitiseIconRef(ref: IconRef | undefined, name: string): IconRef | undefined {
  const fallback = (): IconRef | undefined => {
    const letter = [...name.trim()][0]?.toUpperCase();
    return letter ? { kind: "letter", letter } : undefined;
  };
  if (!ref) return fallback();
  switch (ref.kind) {
    case "url": {
      const c = checkUrl(ref.src);
      return c && !c.hadUserinfo ? { kind: "url", src: c.url.href } : fallback();
    }
    case "proxied":
      return PROXIED_RE.test(ref.src) && !ref.src.includes("..") ? { kind: "proxied", src: ref.src } : fallback();
    case "letter": {
      const letter = [...(ref.letter ?? "")][0];
      return letter ? { kind: "letter", letter } : fallback();
    }
    default:
      return fallback();
  }
}
