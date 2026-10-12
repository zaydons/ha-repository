// Hot reload trigger (design §4.8): fs.watch on the config folder (debounced)
// plus a stat poll (mtime + size + inode) for bind mounts and editors that
// don't emit inotify events.
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../types.ts";

export interface WatchOptions {
  debounceMs?: number;
  pollMs?: number;
  /** Disable fs.watch (tests use the poll alone). */
  useFsWatch?: boolean;
}

export interface Watcher {
  stop(): void;
  /** Resolves once the poll baseline is recorded. */
  ready: Promise<void>;
}

export async function fileSignature(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : `error:${code ?? "?"}`;
  }
}

export function watchConfig(dir: string, files: readonly string[], onChange: () => void, log: Logger, opts: WatchOptions = {}): Watcher {
  const debounceMs = opts.debounceMs ?? 300;
  const pollMs = opts.pollMs ?? 3000;
  const names = new Set(files);
  let stopped = false;
  let debounce: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let fsw: FSWatcher | undefined;
  const sigs = new Map<string, string>();

  const fire = () => {
    if (stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      if (!stopped) onChange();
    }, debounceMs);
    debounce.unref();
  };

  const snapshot = async (): Promise<boolean> => {
    let changed = false;
    for (const f of files) {
      const sig = await fileSignature(join(dir, f));
      if (sigs.has(f) && sigs.get(f) !== sig) changed = true;
      sigs.set(f, sig);
    }
    return changed;
  };

  if (opts.useFsWatch !== false) {
    try {
      fsw = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === null || names.has(String(filename))) fire();
      });
      fsw.on("error", (err) => {
        log.warn("File watching stopped; relying on the 3 s poll", { err: err.message });
        fsw?.close();
        fsw = undefined;
      });
    } catch (err) {
      log.warn("File watching unavailable; relying on the 3 s poll", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  const ready = snapshot().then(() => {
    const tick = async () => {
      if (stopped) return;
      try {
        if (await snapshot()) fire();
      } catch (err) {
        log.warn("Config poll failed", { err: err instanceof Error ? err.message : String(err) });
      }
      if (!stopped) {
        poll = setTimeout(tick, pollMs);
        poll.unref();
      }
    };
    poll = setTimeout(tick, pollMs);
    poll.unref();
  });

  return {
    ready,
    stop() {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      if (poll) clearTimeout(poll);
      fsw?.close();
    },
  };
}
