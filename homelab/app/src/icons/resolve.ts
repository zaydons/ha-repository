// Pure parsing of Homepage icon strings (design §6). No I/O here: the service
// in index.ts decides between local / CDN / letter using the parsed spec.
//
//   mdi-<name>[-#rrggbb]        bundled @mdi/svg
//   si-<name>[-#rrggbb]         bundled simple-icons
//   sh-<name>[.png|.svg|.webp]  selfh.st icons (CDN, cached)
//   /icons/<file>               /config/icons/<file> only
//   <name>[.png|.svg|.webp]     /config/icons/<file> if present, else dashboard-icons (CDN, cached)
//   http(s)://...               passed to the browser as-is (userinfo stripped)
//
// Anything else becomes the letter fallback.

/** Bundled pack glyph names (mdi uses '-', simple-icons slugs may use '_'). */
export const PACK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,100}$/;
/** CDN base names (design §6). */
export const CDN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,100}$/;
/** Files in /config/icons/. No slash, no leading dot. */
export const LOCAL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(png|svg|webp)$/;
export const COLOUR_RE = /^[0-9a-fA-F]{6}$/;

export type CdnSet = "di" | "sh";
export type CdnExt = "png" | "svg" | "webp";
export const CDN_EXTS: readonly CdnExt[] = ["png", "svg", "webp"];

/** The only two URL templates the server ever fetches icons from. */
const CDN_BASE: Record<CdnSet, string> = {
  di: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons",
  sh: "https://cdn.jsdelivr.net/gh/selfhst/icons",
};

export type IconSpec =
  | { kind: "pack"; set: "mdi" | "si"; name: string; colour?: string }
  | { kind: "cdn"; set: CdnSet; file: string; localFirst: boolean }
  | { kind: "local"; file: string }
  | { kind: "url"; src: string }
  | { kind: "invalid" };

const MAX_ICON_LENGTH = 2048;

export function parseIcon(raw: string): IconSpec {
  const icon = raw.trim();
  if (!icon || icon.length > MAX_ICON_LENGTH) return { kind: "invalid" };

  if (/^https?:\/\//i.test(icon)) {
    let u: URL;
    try {
      u = new URL(icon);
    } catch {
      return { kind: "invalid" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "invalid" };
    // Never let credentials reach the browser.
    u.username = "";
    u.password = "";
    return { kind: "url", src: u.href };
  }

  const pack = /^(mdi|si)-(.+?)(?:-#([0-9a-fA-F]{6}))?$/.exec(icon);
  if (pack) {
    const set = pack[1] as "mdi" | "si";
    const name = pack[2]!.toLowerCase();
    if (!PACK_NAME_RE.test(name)) return { kind: "invalid" };
    const colour = pack[3]?.toLowerCase();
    return colour ? { kind: "pack", set, name, colour } : { kind: "pack", set, name };
  }
  if (/^(mdi|si)-/.test(icon)) return { kind: "invalid" };

  if (icon.startsWith("/icons/")) {
    const file = icon.slice("/icons/".length);
    return LOCAL_FILE_RE.test(file) ? { kind: "local", file } : { kind: "invalid" };
  }

  const sh = icon.toLowerCase().startsWith("sh-");
  const file = cdnFile(sh ? icon.slice(3) : icon);
  if (!file) return { kind: "invalid" };
  // Local override applies to plain names (Homepage's dashboard-icons form).
  return { kind: "cdn", set: sh ? "sh" : "di", file, localFirst: !sh };
}

/** "plex" -> "plex.png", "Plex.SVG" -> "plex.svg"; null if not a valid CDN name. */
export function cdnFile(value: string): string | null {
  const lower = value.toLowerCase();
  const m = /^(.+?)(?:\.(png|svg|webp))?$/.exec(lower);
  if (!m) return null;
  const base = m[1]!;
  const ext = (m[2] ?? "png") as CdnExt;
  if (!CDN_NAME_RE.test(base) || base.endsWith(".")) return null;
  return `${base}.${ext}`;
}

/** Validate a cached-CDN file name as received on the icons route. */
export function parseCdnFile(file: string): { base: string; ext: CdnExt } | null {
  const m = /^(.+)\.(png|svg|webp)$/.exec(file);
  if (!m) return null;
  const base = m[1]!;
  if (!CDN_NAME_RE.test(base) || base.endsWith(".")) return null;
  return { base, ext: m[2] as CdnExt };
}

/** Build the fixed CDN URL. Throws on an invalid name (callers validate first). */
export function cdnUrl(set: CdnSet, file: string): string {
  const p = parseCdnFile(file);
  if (!p) throw new Error("invalid CDN icon name");
  return `${CDN_BASE[set]}/${p.ext}/${encodeURIComponent(p.base)}.${p.ext}`;
}

export function letterFor(serviceName: string): string | undefined {
  const first = Array.from(serviceName.trim())[0];
  return first ? first.toUpperCase() : undefined;
}

/**
 * Content-Type allowlist keyed on the file extension (threat model R4). Never
 * taken from an upstream response.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export function contentTypeFor(file: string): string | null {
  const ext = /\.([a-z]+)$/.exec(file)?.[1];
  return (ext && Object.hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : undefined) ?? null;
}
