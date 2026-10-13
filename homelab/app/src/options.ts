// App options (/data/options.json) and the config folder path shown in UI copy.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AppOptions, Logger, LogLevel, ThemeOption } from "./types.ts";

export const DEFAULT_OPTIONS: Readonly<AppOptions> = { theme: "auto", log_level: "info" };

const THEMES: readonly ThemeOption[] = ["auto", "light", "dark"];
const LEVELS: readonly LogLevel[] = ["debug", "info", "warning", "error"];

/** Validate an options object; unknown or invalid values fall back to defaults. */
export function parseOptions(raw: unknown): { options: AppOptions; invalid: string[] } {
  const options: AppOptions = { ...DEFAULT_OPTIONS };
  const invalid: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { options, invalid: raw === undefined ? [] : ["(not an object)"] };
  }
  const o = raw as Record<string, unknown>;
  if (o.theme !== undefined) {
    if (THEMES.includes(o.theme as ThemeOption)) options.theme = o.theme as ThemeOption;
    else invalid.push("theme");
  }
  if (o.log_level !== undefined) {
    if (LEVELS.includes(o.log_level as LogLevel)) options.log_level = o.log_level as LogLevel;
    else invalid.push("log_level");
  }
  return { options, invalid };
}

/**
 * Where to read the app options. The Supervisor writes /data/options.json
 * readable by root only, so entrypoint.sh (still root) copies it to a
 * root-owned, node-readable file and passes that path in HL_OPTIONS_FILE.
 * Without it (local runs), read <dataDir>/options.json directly.
 */
export function optionsFilePath(env: NodeJS.ProcessEnv, dataDir: string): string {
  const f = env.HL_OPTIONS_FILE;
  return f && isAbsolute(f) ? f : join(dataDir, "options.json");
}

export async function readOptions(file: string, log: Logger): Promise<AppOptions> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log.warn(`Can't read app options; using defaults`, { code });
    return { ...DEFAULT_OPTIONS };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    log.warn("App options are not valid JSON; using defaults");
    return { ...DEFAULT_OPTIONS };
  }
  const { options, invalid } = parseOptions(raw);
  if (invalid.length) log.warn(`Ignoring invalid app options: ${invalid.join(", ")}`);
  return options;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

export function configPathFor(fullSlug: string | null): string {
  return fullSlug && SLUG_RE.test(fullSlug) ? `/addon_configs/${fullSlug}/` : "/addon_configs/";
}

/**
 * Container hostnames are the full slug with every "_" turned into "-"
 * ("a1b2c3d4_homelab" -> "a1b2c3d4-homelab", "local_homelab_dev" ->
 * "local-homelab-dev"). Slugs can't contain "-", so every "-" maps back to "_".
 * This is a fallback for the Supervisor lookup; a name without "-" (a random
 * Docker container id) gives null.
 */
export function slugFromHostname(name: string): string | null {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(name)) return null;
  const slug = name.replaceAll("-", "_");
  return SLUG_RE.test(slug) ? slug : null;
}

/** Shape of GET http://supervisor/addons/self/info: { result, data: { slug } }. */
export function slugFromSupervisorInfo(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return null;
  const slug = (data as { slug?: unknown }).slug;
  return typeof slug === "string" && SLUG_RE.test(slug) ? slug : null;
}

/**
 * The folder the user sees, e.g. "/addon_configs/a1b2c3d4_homelab/". The full
 * slug comes from the Supervisor (allowed for every app without hassio_api),
 * so nothing here depends on the slug in config.yaml.
 */
export async function resolveConfigPathDisplay(log: Logger, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const token = env.SUPERVISOR_TOKEN;
  if (token) {
    for (const path of ["/addons/self/info", "/v2/apps/self/info"]) {
      try {
        const res = await fetch(`http://supervisor${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) {
          log.debug(`Supervisor ${path} returned HTTP ${res.status}`);
          continue;
        }
        const slug = slugFromSupervisorInfo(await res.json());
        if (slug) return configPathFor(slug);
      } catch (err) {
        log.debug(`Supervisor ${path} lookup failed`, { err: err instanceof Error ? err.message : String(err) });
      }
    }
    log.warn("Couldn't get this app's slug from the Supervisor; config folder path in the UI may be approximate");
  }
  return configPathFor(slugFromHostname(hostname()));
}
