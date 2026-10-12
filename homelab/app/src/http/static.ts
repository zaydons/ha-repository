// Static files: index.html at "./", web/ under "static/", and a fixed
// allowlist of three vendor ES modules from node_modules.
import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Logger } from "../types.ts";

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const MAX_STATIC_BYTES = 2 * 1024 * 1024;

/** vendor/<name> -> file under node_modules. hooks imports the bare "preact" specifier, rewritten below. */
const VENDOR_FILES: Readonly<Record<string, string>> = {
  "preact.mjs": "preact/dist/preact.mjs",
  "hooks.mjs": "preact/hooks/dist/hooks.mjs",
  "htm.mjs": "htm/dist/htm.mjs",
};

export const VENDOR_NAMES: readonly string[] = Object.keys(VENDOR_FILES);

/**
 * Browsers can't resolve bare specifiers without an import map, and an inline
 * import map would need a CSP exception. Rewrite `from"preact"` to the
 * sibling vendor file instead.
 */
export function rewriteBareImports(source: string): string {
  return source.replace(/(\bfrom\s*)(["'])preact\2/g, "$1$2./preact.mjs$2");
}

export interface StaticFiles {
  index(): Promise<StaticFile | null>;
  /** `rel` is the already percent-decoded path after "static/". */
  file(rel: string): Promise<StaticFile | null>;
  vendor(name: string): StaticFile | null;
}

export function createStaticFiles(webDir: string, nodeModulesDir: string, log: Logger): StaticFiles {
  const root = resolve(webDir);
  const vendor = new Map<string, StaticFile>();
  for (const [name, rel] of Object.entries(VENDOR_FILES)) {
    try {
      const src = readFileSync(join(nodeModulesDir, rel), "utf8");
      const body = rewriteBareImports(src);
      if (/\bfrom\s*["'][^."'/]/.test(body)) log.warn(`vendor/${name} still has a bare import specifier`);
      vendor.set(name, { body: Buffer.from(body, "utf8"), contentType: CONTENT_TYPES[".mjs"]! });
    } catch (err) {
      log.error(`Can't load vendor module ${name}`, { err });
    }
  }

  async function load(rel: string): Promise<StaticFile | null> {
    if (rel.length === 0 || rel.length > 200) return null;
    if (rel.includes("\0") || rel.includes("\\")) return null;
    const segments = rel.split("/");
    // No empty, dot or dot-dot segments, no hidden files.
    if (segments.some((s) => s === "" || s.startsWith("."))) return null;
    const type = CONTENT_TYPES[extname(rel).toLowerCase()];
    if (!type) return null;

    const candidate = resolve(root, rel);
    if (!candidate.startsWith(root + sep)) return null;
    try {
      // Resolve symlinks too, then re-check the prefix.
      const [realRoot, real] = await Promise.all([realpath(root), realpath(candidate)]);
      if (!real.startsWith(realRoot + sep)) return null;
      const st = await stat(real);
      if (!st.isFile() || st.size > MAX_STATIC_BYTES) return null;
      return { body: await readFile(real), contentType: type };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") log.warn("Static file read failed", { file: rel, code });
      return null;
    }
  }

  return {
    index: () => load("index.html"),
    file: load,
    vendor: (name) => vendor.get(name) ?? null,
  };
}
