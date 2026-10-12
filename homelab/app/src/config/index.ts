// ConfigService (WS1): loads /config, keeps the last good config (in memory
// and in /data/last-good.json), projects the public config, hot-reloads.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  BootContext,
  ConfigService,
  IconService,
  NormalisedConfig,
  Problem,
  PublicConfig,
} from "../types.ts";
import type { WidgetPlugin } from "../widgets/types.ts";
import { setLogSecrets } from "../log.ts";
import { buildConfig, CA_FILE, IGNORED_FILES, WATCHED_FILES, SECRETS_FILE, SERVICES_FILE, SETTINGS_FILE } from "./load.ts";
import type { BuiltConfig, FatalConfig, SourceTexts } from "./load.ts";
import { readLastGood, textsHash, writeLastGood } from "./last-good.ts";
import { project } from "./project.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { fileSignature, watchConfig } from "./watch.ts";
import type { Watcher, WatchOptions } from "./watch.ts";

/** Config files larger than this are refused (they'd never be hand-written). */
export const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ConfigServiceOptions extends WatchOptions {
  /** false = no watcher (tests call reload()). Default true. */
  watch?: boolean;
  now?: () => Date;
}

export interface ConfigServiceImpl extends ConfigService {
  /** Re-read the files now. Concurrent calls coalesce. */
  reload(): Promise<void>;
}

type ReadResult = { ok: true; texts: SourceTexts } | { ok: false; error: Problem };

async function readText(dir: string, name: string): Promise<string | null> {
  const path = join(dir, name);
  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
    size = s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (size > MAX_CONFIG_BYTES) throw Object.assign(new Error("too large"), { code: "EFBIG" });
  const text = await readFile(path, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readSources(dir: string): Promise<ReadResult> {
  const texts: SourceTexts = { services: null, settings: null, secrets: null };
  for (const [key, file] of [
    ["services", SERVICES_FILE],
    ["settings", SETTINGS_FILE],
    ["secrets", SECRETS_FILE],
  ] as const) {
    try {
      texts[key] = await readText(dir, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      const message =
        code === "EACCES" || code === "EPERM"
          ? `Can't read ${file}: permission denied. Make it readable, e.g. chmod 644.`
          : code === "EFBIG"
            ? `${file} is larger than 1 MB, so it wasn't loaded.`
            : code === "EISDIR"
              ? `${file} isn't a regular file.`
              : `Can't read ${file} (${code}).`;
      return { ok: false, error: { severity: "error", file, code: "file.read", message } };
    }
  }
  return { ok: true, texts };
}

async function presentIgnoredFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of IGNORED_FILES) {
    try {
      await stat(join(dir, f));
      out.push(f);
    } catch {
      // absent
    }
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function createConfigService(
  ctx: BootContext,
  plugins: readonly WidgetPlugin[],
  icons: Pick<IconService, "resolve">,
  opts: ConfigServiceOptions = {},
): ConfigServiceImpl {
  const log = ctx.log.child("config");
  const now = opts.now ?? (() => new Date());
  const { configDir, dataDir, sampleDir } = ctx.paths;
  const listeners = new Set<(cfg: NormalisedConfig) => void>();

  let sampleHash: string | null = null;
  let good: { built: BuiltConfig; loadedAt: string; sampleInUse: boolean; textsHash: string } | null = null;
  let fatal: FatalConfig | null = null;
  let rev = 0;
  let publicCfg: PublicConfig;
  let publicKey = "";
  let normalised: NormalisedConfig | null = null;
  let normalisedKey = "";
  /** ca.pem mtime/size/inode: a change re-fires onChange so the scheduler reloads it (review N2). */
  let caSig = "absent";
  let persistedHash: string | null = null;
  let watcher: Watcher | undefined;
  let running: Promise<void> | null = null;
  let pending = false;
  let stopped = false;

  const rebuildPublic = () => {
    const base = {
      theme: ctx.options.theme,
      configPath: ctx.configPathDisplay,
      usingLastGood: fatal !== null && good !== null,
      hardSecrets: good?.built.hardSecrets ?? [],
    };
    const problems: Problem[] = [];
    if (fatal) problems.push(...fatal.problems);
    if (good) problems.push(...good.built.problems);
    const input = {
      ...base,
      rev: 0,
      sampleInUse: good?.sampleInUse ?? false,
      loadedAt: good?.loadedAt ?? now().toISOString(),
      settings: good?.built.settings ?? { ...DEFAULT_SETTINGS },
      groups: good?.built.groups ?? [],
      problems,
      ...(fatal ? { error: fatal.error } : {}),
    };
    const candidate = project(input);
    const { rev: _r, loadedAt: _l, ...rest } = candidate;
    const key = JSON.stringify(rest) + (good ? good.loadedAt : "");
    if (key !== publicKey) {
      publicKey = key;
      rev += 1;
      publicCfg = { ...candidate, rev };
    } else {
      publicCfg = { ...publicCfg, rev };
    }
  };

  const updateNormalised = () => {
    if (!good) return;
    const b = good.built;
    const key = JSON.stringify([b.settings, b.tiles.map((t) => [t.id, t.hash, t.name, t.groupPath]), caSig]);
    const changed = key !== normalisedKey;
    normalisedKey = key;
    normalised = { rev, settings: { ...b.settings }, tiles: b.tiles, secrets: b.secrets };
    if (changed) {
      for (const l of listeners) {
        try {
          l(normalised);
        } catch (err) {
          log.error("A config change listener failed", { err: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  };

  const registerSecrets = () => {
    setLogSecrets([...(good?.built.secrets ?? []), ...(fatal?.secrets ?? [])]);
  };

  const describeProblem = (p: Problem) => `${p.file}${p.line !== undefined ? `:${p.line}` : ""}${p.col !== undefined ? `:${p.col}` : ""} ${p.message}`;

  const acceptGood = async (built: BuiltConfig, texts: SourceTexts, loadedAt: string, persist: boolean) => {
    const th = textsHash(texts);
    const sampleInUse = texts.services !== null && sampleHash !== null && sha256(texts.services) === sampleHash;
    const sameAsBefore = good !== null && good.textsHash === th;
    good = { built, loadedAt: sameAsBefore ? good!.loadedAt : loadedAt, sampleInUse, textsHash: th };
    if (persist && persistedHash !== th) {
      try {
        await writeLastGood(dataDir, { savedAt: loadedAt, files: texts });
        persistedHash = th;
      } catch (err) {
        log.warn("Couldn't save the last working config", { code: (err as NodeJS.ErrnoException).code ?? "error" });
      }
    }
  };

  const doLoad = async (initial: boolean) => {
    const read = await readSources(configDir);
    caSig = await fileSignature(join(configDir, CA_FILE));
    const ignoredFiles = await presentIgnoredFiles(configDir);
    const wasFatal = fatal;
    const hadGood = good;
    if (!read.ok) {
      fatal = { ok: false, error: read.error, problems: [read.error], secrets: [] };
    } else {
      const res = buildConfig(read.texts, { plugins, icons, ignoredFiles, knownSecrets: good?.built.secrets ?? [] });
      if (res.ok) {
        fatal = null;
        await acceptGood(res, read.texts, now().toISOString(), true);
      } else {
        fatal = res;
      }
    }

    if (fatal && !good && initial) {
      // Restart with a broken file: fall back to the persisted last good config.
      try {
        const lg = await readLastGood(dataDir);
        if (lg) {
          const res = buildConfig(lg.files, { plugins, icons, ignoredFiles });
          if (res.ok) {
            persistedHash = textsHash(lg.files);
            await acceptGood(res, lg.files, lg.savedAt, false);
            log.info(`Using the last working config from ${lg.savedAt}`);
          }
        }
      } catch (err) {
        log.warn("Ignoring an unreadable last-good.json", { err: err instanceof Error ? err.message : String(err) });
      }
    }

    registerSecrets();
    const prevRev = rev;
    rebuildPublic();
    updateNormalised();

    if (rev !== prevRev || initial) {
      if (fatal) {
        log.warn(`Config error: ${describeProblem(fatal.error)}${good ? " (showing the last working config)" : ""}`);
      } else if (good && (good !== hadGood || wasFatal || initial)) {
        const c = good.built.counts;
        const warnings = good.built.problems.filter((p) => p.severity !== "info").length;
        log.info(`Config loaded: ${c.groups} groups, ${c.services} services, ${c.widgets} widgets (${warnings} warnings)`);
        for (const p of good.built.problems) if (p.severity !== "info") log.debug(`Config warning: ${describeProblem(p)}`);
      }
    }
  };

  const reload = async (initial = false): Promise<void> => {
    if (running) {
      pending = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          pending = false;
          await doLoad(initial);
          initial = false;
        } while (pending && !stopped);
      } catch (err) {
        log.error("Config reload failed", { err: err instanceof Error ? err.message : String(err) });
      } finally {
        running = null;
      }
    })();
    return running;
  };

  rebuildPublic();

  return {
    async start() {
      try {
        sampleHash = sha256(await readFile(join(sampleDir, SERVICES_FILE), "utf8"));
      } catch {
        sampleHash = null;
      }
      await reload(true);
      if (opts.watch !== false && !stopped) {
        watcher = watchConfig(configDir, WATCHED_FILES, () => void reload(), log, opts);
        await watcher.ready;
      }
    },
    async stop() {
      stopped = true;
      watcher?.stop();
      if (running) await running;
    },
    reload: () => reload(false),
    getPublic: () => publicCfg,
    getNormalised: () => normalised,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
