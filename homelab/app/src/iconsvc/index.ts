// WS6: the icon service (design §6).
//
// - resolve(): Homepage icon string -> IconRef for api/config (sync; called by WS1).
// - get():     bytes for GET icons/<set>/<name> (the route itself is WS0's).
//
// mdi/si come from the bundled packs (read as SVG files; the simple-icons JS
// bundle is removed from the image). dashboard-icons (di) and selfh.st (sh)
// are fetched by the server from two fixed CDN templates, once, and cached in
// /data/icon-cache/<set>/. Only names that the config referenced (via
// resolve) are ever fetched, so the browser cannot make the server fetch
// arbitrary names. /config/custom-icons/ wins over the CDN.
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootContext, IconRef, IconResponse, IconService, IconSet } from "../types.ts";
import { fetchIcon, MAX_ICON_BYTES } from "./cdn.ts";
import type { FetchFn } from "./cdn.ts";
import {
  cdnUrl,
  COLOUR_RE,
  contentTypeFor,
  LOCAL_DIR,
  LOCAL_FILE_RE,
  PACK_NAME_RE,
  letterFor,
  parseCdnFile,
  parseIcon,
} from "./resolve.ts";
import type { CdnSet } from "./resolve.ts";
import { colourSvg, matchesType } from "./svg.ts";

export const NEGATIVE_NOT_FOUND_MS = 24 * 60 * 60 * 1000;
export const NEGATIVE_FAILURE_MS = 10 * 60 * 1000;
export const CACHE_CAP_BYTES = 50 * 1024 * 1024;
const MAX_NEGATIVE_ENTRIES = 5000;
const MAX_WANTED_ENTRIES = 2000;
const PACK_CACHE_CONTROL = "public, max-age=86400";
const LOCAL_CACHE_CONTROL = "public, max-age=300";

const DEFAULT_NODE_MODULES = fileURLToPath(new URL("../../node_modules", import.meta.url));

export interface IconServiceOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: FetchFn;
  /** Clock in ms; injected in tests. */
  now?: () => number;
  nodeModulesDir?: string;
  cacheCapBytes?: number;
}

/** The extended service exposes settle() so tests can wait for background prefetches. */
export interface IconServiceImpl extends IconService {
  /** Resolves when all in-flight CDN fetches (and the cache sweep) have finished. */
  settle(): Promise<void>;
}

export function createIconService(ctx: BootContext, opts: IconServiceOptions = {}): IconServiceImpl {
  const log = ctx.log.child("icons");
  const fetchFn: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const nodeModules = opts.nodeModulesDir ?? DEFAULT_NODE_MODULES;
  const cap = opts.cacheCapBytes ?? CACHE_CAP_BYTES;
  const packDirs = {
    mdi: join(nodeModules, "@mdi", "svg", "svg"),
    si: join(nodeModules, "simple-icons", "icons"),
  };
  const localDir = join(ctx.paths.configDir, LOCAL_DIR);
  const cacheRoot = join(ctx.paths.dataDir, "icon-cache");
  if (existsSync(join(ctx.paths.configDir, "icons")) && !existsSync(localDir)) {
    log.warn(`Local icons are read from the ${LOCAL_DIR} folder, not icons; rename the folder to use them`);
  }

  const negative = new Map<string, number>(); // key -> expiry (ms)
  const inflight = new Map<string, Promise<IconResponse | null>>();
  const wanted = new Set<string>(); // "di/plex.png" keys the config referenced
  let sweep: Promise<void> = Promise.resolve();
  let sweepQueued = false;

  const cachePath = (set: CdnSet, file: string) => join(cacheRoot, set, file);

  function isNegative(key: string): boolean {
    const until = negative.get(key);
    if (until === undefined) return false;
    if (now() < until) return true;
    negative.delete(key);
    return false;
  }

  function setNegative(key: string, ms: number): void {
    negative.delete(key);
    negative.set(key, now() + ms);
    if (negative.size > MAX_NEGATIVE_ENTRIES) {
      const oldest = negative.keys().next().value;
      if (oldest !== undefined) negative.delete(oldest);
    }
  }

  function addWanted(key: string): void {
    if (wanted.has(key)) return;
    wanted.add(key);
    if (wanted.size > MAX_WANTED_ENTRIES) {
      const oldest = wanted.values().next().value;
      if (oldest !== undefined) wanted.delete(oldest);
    }
  }

  function localFileExists(file: string): boolean {
    try {
      return statSync(join(localDir, file)).isFile();
    } catch {
      return false;
    }
  }

  /** Read /config/custom-icons/<file>, refusing anything that resolves outside that folder. */
  async function readLocal(file: string): Promise<IconResponse | null> {
    if (!LOCAL_FILE_RE.test(file)) return null;
    const contentType = contentTypeFor(file);
    if (!contentType) return null;
    try {
      const dir = await realpath(localDir);
      const real = await realpath(join(localDir, file));
      if (!real.startsWith(dir + sep)) {
        log.warn(`Ignoring local icon ${file}: it points outside the ${LOCAL_DIR} folder`);
        return null;
      }
      const st = await stat(real);
      if (!st.isFile() || st.size > MAX_ICON_BYTES) {
        log.warn(`Ignoring local icon ${file}: not a regular file of at most 1 MB`);
        return null;
      }
      const body = await readFile(real);
      if (!matchesType(body, contentType)) {
        log.warn(`Ignoring local icon ${file}: content does not match its extension, or the SVG has scripts or external references`);
        return null;
      }
      return { body, contentType, cacheControl: LOCAL_CACHE_CONTROL };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`Could not read local icon ${file}`, { err: (err as Error).message });
      }
      return null;
    }
  }

  async function readPack(set: "mdi" | "si", name: string, query: URLSearchParams): Promise<IconResponse | null> {
    const m = /^(.+)\.svg$/.exec(name);
    if (!m || !PACK_NAME_RE.test(m[1]!)) return null;
    let body: Buffer;
    try {
      body = await readFile(join(packDirs[set], `${m[1]}.svg`));
    } catch {
      return null;
    }
    const c = query.get("c");
    if (c && COLOUR_RE.test(c)) body = colourSvg(body, c);
    return { body, contentType: "image/svg+xml", cacheControl: PACK_CACHE_CONTROL };
  }

  async function readCached(set: CdnSet, file: string): Promise<IconResponse | null> {
    const path = cachePath(set, file);
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.size > MAX_ICON_BYTES) return null;
      const body = await readFile(path);
      const contentType = contentTypeFor(file)!;
      if (!matchesType(body, contentType)) {
        await unlink(path).catch(() => {});
        return null;
      }
      // LRU bookkeeping: bump atime explicitly (the volume may be noatime).
      utimes(path, new Date(now()), st.mtime).catch(() => {});
      return { body, contentType };
    } catch {
      return null;
    }
  }

  async function store(set: CdnSet, file: string, body: Buffer): Promise<void> {
    const dir = join(cacheRoot, set);
    const tmp = join(dir, `.${file}.${process.pid}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, cachePath(set, file));
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      log.warn(`Could not cache icon ${set}/${file}`, { err: (err as Error).message });
      return;
    }
    scheduleSweep();
  }

  function scheduleSweep(): void {
    if (sweepQueued) return;
    sweepQueued = true;
    sweep = sweep.then(async () => {
      sweepQueued = false;
      try {
        await enforceCap();
      } catch (err) {
        log.warn("Icon cache clean-up failed", { err: (err as Error).message });
      }
    });
  }

  /** Keep the cache under the cap, evicting the least recently used files first. */
  async function enforceCap(): Promise<void> {
    const files: Array<{ path: string; size: number; atime: number }> = [];
    let total = 0;
    for (const set of ["di", "sh"] as const) {
      const dir = join(cacheRoot, set);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const path = join(dir, n);
        try {
          const st = await lstat(path);
          if (!st.isFile()) continue;
          files.push({ path, size: st.size, atime: st.atimeMs });
          total += st.size;
        } catch {
          // Removed meanwhile.
        }
      }
    }
    if (total <= cap) return;
    files.sort((a, b) => a.atime - b.atime);
    let evicted = 0;
    for (const f of files) {
      if (total <= cap) break;
      await unlink(f.path).catch(() => {});
      total -= f.size;
      evicted++;
    }
    log.info(`Icon cache over ${Math.round(cap / 1024 / 1024)} MB: evicted ${evicted} least recently used file(s)`);
  }

  /** Fetch from the CDN once (single-flight per key), cache it, or record a miss. */
  function fetchAndStore(set: CdnSet, file: string): Promise<IconResponse | null> {
    const key = `${set}/${file}`;
    const running = inflight.get(key);
    if (running) return running;
    const p = (async (): Promise<IconResponse | null> => {
      const r = await fetchIcon(fetchFn, cdnUrl(set, file), file);
      if (!r.ok) {
        setNegative(key, r.notFound ? NEGATIVE_NOT_FOUND_MS : NEGATIVE_FAILURE_MS);
        const retry = r.notFound ? "24 h" : "10 min";
        log.warn(`Icon ${key} is unavailable from the CDN (${r.reason}); showing the letter instead, retry in ${retry}`);
        return null;
      }
      negative.delete(key);
      await store(set, file, r.body);
      log.info(`Cached icon ${key} (${Math.ceil(r.body.length / 1024)} KB)`);
      return { body: r.body, contentType: r.contentType };
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function getCdn(set: CdnSet, name: string): Promise<IconResponse | null> {
    if (!parseCdnFile(name)) return null;
    const cached = await readCached(set, name);
    if (cached) return cached;
    const key = `${set}/${name}`;
    // Only fetch names the config asked for; never on a browser's say-so.
    if (isNegative(key) || !wanted.has(key)) return null;
    return fetchAndStore(set, name);
  }

  function letter(serviceName: string): IconRef | undefined {
    const l = letterFor(serviceName);
    return l ? { kind: "letter", letter: l } : undefined;
  }

  return {
    async get(set: IconSet, name: string, query: URLSearchParams): Promise<IconResponse | null> {
      switch (set) {
        case "mdi":
        case "si":
          return readPack(set, name, query);
        case "local":
          return readLocal(name);
        case "di":
        case "sh":
          return getCdn(set, name);
        default:
          return null;
      }
    },

    resolve(icon: string | undefined, serviceName: string): IconRef | undefined {
      if (typeof icon !== "string" || icon.trim() === "") return letter(serviceName);
      const spec = parseIcon(icon);
      switch (spec.kind) {
        case "url":
          return { kind: "url", src: spec.src };
        case "pack": {
          if (!existsSync(join(packDirs[spec.set], `${spec.name}.svg`))) {
            log.debug(`No ${spec.set} icon named "${spec.name}"; using the letter`);
            return letter(serviceName);
          }
          const q = spec.colour ? `?c=${spec.colour}` : "";
          return { kind: "proxied", src: `icons/${spec.set}/${spec.name}.svg${q}` };
        }
        case "local":
          return localFileExists(spec.file) ? { kind: "proxied", src: `icons/local/${spec.file}` } : letter(serviceName);
        case "cdn": {
          if (spec.localFirst && LOCAL_FILE_RE.test(spec.file) && localFileExists(spec.file)) {
            return { kind: "proxied", src: `icons/local/${spec.file}` };
          }
          const key = `${spec.set}/${spec.file}`;
          if (isNegative(key)) return letter(serviceName);
          addWanted(key);
          if (!existsSync(cachePath(spec.set, spec.file)) && !inflight.has(key)) {
            // Warm the cache in the background so icons work offline after the first load.
            fetchAndStore(spec.set, spec.file).catch((err: unknown) =>
              log.warn(`Icon prefetch failed for ${key}`, { err: err instanceof Error ? err.message : String(err) }),
            );
          }
          return { kind: "proxied", src: `icons/${spec.set}/${spec.file}` };
        }
        default:
          log.debug("Icon value is not a recognised Homepage icon; using the letter");
          return letter(serviceName);
      }
    },

    async settle(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight.values()]);
      await sweep;
    },
  };
}
