// /data/last-good.json (design §4.1, threat model R6): the source texts of the
// last config that loaded without a fatal error, so a broken edit survives a
// restart. Mode 0600, written atomically, never served.
import { createHash } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceTexts } from "./load.ts";

export const LAST_GOOD_FILE = "last-good.json";
const VERSION = 1;
const MAX_BYTES = 5 * 1024 * 1024;

export interface LastGood {
  savedAt: string;
  files: SourceTexts;
}

export function textsHash(t: SourceTexts): string {
  return createHash("sha256").update(JSON.stringify([t.services, t.settings, t.secrets])).digest("hex");
}

function isTextOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

export async function readLastGood(dataDir: string): Promise<LastGood | null> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, LAST_GOOD_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (raw.length > MAX_BYTES) throw new Error("last-good.json is too large");
  const j = JSON.parse(raw) as unknown;
  if (!j || typeof j !== "object") throw new Error("last-good.json has an unexpected shape");
  const o = j as { version?: unknown; savedAt?: unknown; files?: Record<string, unknown> };
  if (o.version !== VERSION || typeof o.savedAt !== "string" || !o.files || typeof o.files !== "object") {
    throw new Error("last-good.json has an unexpected shape");
  }
  const { services, settings, secrets } = o.files;
  if (!isTextOrNull(services) || !isTextOrNull(settings) || !isTextOrNull(secrets)) throw new Error("last-good.json has an unexpected shape");
  return { savedAt: o.savedAt, files: { services, settings, secrets } };
}

export async function writeLastGood(dataDir: string, lg: LastGood): Promise<void> {
  const target = join(dataDir, LAST_GOOD_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  const body = JSON.stringify({ version: VERSION, savedAt: lg.savedAt, files: lg.files });
  // "wx" refuses to follow a pre-planted file or symlink at the temp path.
  await unlink(tmp).catch(() => {});
  try {
    await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
