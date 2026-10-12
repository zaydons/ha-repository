// Scheduler (design §4.7): status checks run continuously; widget fetches run
// only while a viewer polled api/state in the last 2 minutes. A global
// semaphore caps outbound jobs at 8, each job is single-flight, and
// api/refresh re-runs everything now (1 per 10 s).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BootContext,
  ConfigService,
  Logger,
  NormalisedConfig,
  NormalisedTile,
  NormalisedWidget,
  NowPlayingItem,
  RefreshResult,
  Settings,
  StateService,
  StateSnapshot,
  StatusResult,
  WidgetErrorKind,
  WidgetResult,
  WidgetResultError,
  WidgetValue,
} from "./types.ts";
import type { Store } from "./store.ts";
import type { HttpClient, WidgetContext, WidgetPlugin } from "./widgets/types.ts";
import { WidgetError } from "./widgets/types.ts";
import { findPlugin as registryFindPlugin } from "./widgets/index.ts";
import { checkHttp as defaultCheckHttp } from "./checks/http.ts";
import type { HttpCheckOptions } from "./checks/http.ts";
import { checkPing as defaultCheckPing } from "./checks/ping.ts";
import type { PingOptions } from "./checks/ping.ts";
import type { CheckOutcome } from "./checks/types.ts";
import { redact } from "./redact.ts";

export const VIEWER_TTL_MS = 120_000;
export const REFRESH_LIMIT_MS = 10_000;
export const REFRESH_MAX_MS = 10_000;
export const MAX_CONCURRENT = 8;
export const START_JITTER_MS = 5_000;
export const MIN_INTERVAL_S = 10;
const TICK_MS = 1_000;
/** Hard cap on one status check (HEAD + GET retry at 5 s each, plus margin). */
const CHECK_GUARD_MS = 12_000;
const MAX_TEXT = 200;
const MAX_NOW_PLAYING = 20;
/** Error kinds after which the last good values are kept (shown stale by the UI). */
const KEEP_VALUES_ON: ReadonlySet<WidgetErrorKind> = new Set(["unreachable", "timeout", "bad_response"]);

/** Same shape as WS3's WidgetHttpEnv (widgets/lib/http-client.ts). */
export interface WidgetHttpEnv {
  /** PEM text of /config/ca.pem, from loadCa(). */
  ca?: string;
  signal?: AbortSignal;
  secrets?: readonly string[];
  log?: Logger;
}
/** Matches WS3's `createWidgetHttpClient(w, env)`; server.ts passes it in. */
export type HttpClientFactory = (w: NormalisedWidget, env: WidgetHttpEnv) => HttpClient;
/** Matches WS3's `loadCaPem(configDir)`: undefined when absent; throws WidgetError("config") when unusable. */
export type CaLoader = (configDir: string) => Promise<string | undefined>;

export interface SchedulerDeps {
  /** Wall clock in ms. */
  now?: () => number;
  random?: () => number;
  checkHttp?: (url: string, opts: HttpCheckOptions) => Promise<CheckOutcome>;
  checkPing?: (host: string, opts: PingOptions) => Promise<CheckOutcome>;
  findPlugin?: (type: string) => WidgetPlugin | undefined;
  createHttpClient?: HttpClientFactory;
  /** Loads /config/ca.pem once per config load (WS3 loadCaPem). */
  loadCa?: CaLoader;
  maxConcurrent?: number;
  /** Timer period; 0 disables the internal timer (tests drive tick()). */
  tickMs?: number;
}

type JobKind = "status" | "widget";

interface Job {
  kind: JobKind;
  tileId: string;
  tile: NormalisedTile;
  nextDue: number;
  running: boolean;
  queued: boolean;
  cancelled: boolean;
  /** Run again as soon as the current run finishes (refresh during a run). */
  rerun: boolean;
  startedAt: number;
  /** When the last run finished (0 = never). */
  finishedAt: number;
  controller?: AbortController;
}

interface TileEntry {
  tile: NormalisedTile;
  status?: Job;
  widget?: Job;
}

interface RefreshRound {
  startedAt: number;
  pending: Set<Job>;
  timer: ReturnType<typeof setTimeout>;
}

const noHttpClient: HttpClientFactory = () => {
  throw new WidgetError("config", "Widget HTTP client is not available in this build");
};

/** Fallback when server.ts doesn't pass WS3's loadCaPem. */
const readCaPem: CaLoader = async (configDir) => {
  try {
    return await readFile(join(configDir, "ca.pem"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WidgetError("config", `Can't read ca.pem (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
};

/** A plugin run may make several requests, each with its own timeoutS (HttpClient). This backstop only frees the slot from a plugin that ignores its signal. */
export const RUN_DEADLINE_FACTOR = 3;
export const MIN_RUN_DEADLINE_S = 30;

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

function sanitizeValue(v: unknown): WidgetValue {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return clip(v);
  return null;
}

/** Plugins hand us upstream text: keep only display strings of bounded size. */
export function sanitizeNowPlaying(items: unknown): NowPlayingItem[] {
  if (!Array.isArray(items)) return [];
  const out: NowPlayingItem[] = [];
  for (const it of items) {
    if (out.length >= MAX_NOW_PLAYING) break;
    if (!it || typeof it !== "object") continue;
    const src = it as Record<string, unknown>;
    if (typeof src.title !== "string" || src.title.length === 0) continue;
    const item: NowPlayingItem = { title: clip(src.title) };
    if (typeof src.subtitle === "string" && src.subtitle) item.subtitle = clip(src.subtitle);
    if (typeof src.user === "string" && src.user) item.user = clip(src.user);
    if (typeof src.progressPct === "number" && Number.isFinite(src.progressPct)) {
      item.progressPct = Math.min(100, Math.max(0, src.progressPct));
    }
    if (typeof src.paused === "boolean") item.paused = src.paused;
    out.push(item);
  }
  return out;
}

function widgetHost(w: NormalisedWidget): string | undefined {
  if (typeof w.cfg.url !== "string") return undefined;
  try {
    return new URL(w.cfg.url).hostname.replace(/^\[(.*)\]$/, "$1") || undefined;
  } catch {
    return undefined;
  }
}

class TimeoutSignal extends Error {
  constructor() {
    super("timed out");
    this.name = "TimeoutSignal";
  }
}

/** Resolve or reject with `p`, or reject with TimeoutSignal after `ms`. The loser is ignored. */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      onTimeout();
      rejectP(new TimeoutSignal());
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolveP(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        rejectP(e);
      },
    );
  });
}

export class Scheduler implements StateService {
  private readonly ctx: BootContext;
  private readonly config: ConfigService;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly runHttpCheck: NonNullable<SchedulerDeps["checkHttp"]>;
  private readonly runPingCheck: NonNullable<SchedulerDeps["checkPing"]>;
  private readonly findPlugin: (type: string) => WidgetPlugin | undefined;
  private readonly createHttpClient: HttpClientFactory;
  private readonly loadCa: CaLoader;
  private readonly maxConcurrent: number;
  private readonly tickMs: number;

  private tiles = new Map<string, TileEntry>();
  private queue: Job[] = [];
  private active = 0;
  private settings: Settings | null = null;
  private secrets: readonly string[] = [];
  private ca: string | undefined;
  /** User-facing message when ca.pem is unusable (applies to tlsVerify widgets). */
  private caError: string | undefined;
  /** False while ca.pem is (re)loading: no job starts until it is known. */
  private caReady = false;
  private caGen = 0;
  private lastViewer = Number.NEGATIVE_INFINITY;
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private refreshRound: RefreshRound | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private applied = false;
  private stopped = false;

  constructor(ctx: BootContext, config: ConfigService, store: Store, deps: SchedulerDeps = {}) {
    this.ctx = ctx;
    this.config = config;
    this.store = store;
    this.log = ctx.log.child("scheduler");
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.runHttpCheck = deps.checkHttp ?? defaultCheckHttp;
    this.runPingCheck = deps.checkPing ?? defaultCheckPing;
    this.findPlugin = deps.findPlugin ?? registryFindPlugin;
    this.createHttpClient = deps.createHttpClient ?? noHttpClient;
    this.loadCa = deps.loadCa ?? readCaPem;
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? MAX_CONCURRENT);
    this.tickMs = deps.tickMs ?? TICK_MS;
  }

  // --- StateService -------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.config.onChange((cfg) => this.applyConfig(cfg));
    const initial = this.config.getNormalised();
    if (initial) this.applyConfig(initial);
    if (this.tickMs > 0) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const entry of this.tiles.values()) this.cancelEntry(entry);
    this.tiles.clear();
    this.queue = [];
    this.endRefresh();
  }

  snapshot(): Omit<StateSnapshot, "rev"> {
    return this.store.snapshot(new Date(this.now()));
  }

  noteViewer(): void {
    const t = this.now();
    const wasIdle = !this.viewerActive(t);
    this.lastViewer = t;
    if (wasIdle && this.applied && !this.stopped) {
      this.log.debug("Viewer active: widget polling on");
      // Design §4.7: a returning viewer gets a widget round now, even when
      // widgetInterval is longer than the viewer TTL.
      for (const entry of this.tiles.values()) {
        if (entry.widget && !entry.widget.cancelled) entry.widget.nextDue = Math.min(entry.widget.nextDue, t);
      }
      // The first poll after idle starts a widget round at once.
      this.tick();
    }
  }

  requestRefresh(): RefreshResult {
    const t = this.now();
    const wait = this.lastRefresh + REFRESH_LIMIT_MS - t;
    if (wait > 0) return { accepted: false, retryAfterS: Math.max(1, Math.ceil(wait / 1000)) };
    this.lastRefresh = t;
    this.lastViewer = t; // a refresh comes from someone looking at the page
    this.endRefresh();

    const pending = new Set<Job>();
    for (const entry of this.tiles.values()) {
      for (const job of [entry.status, entry.widget]) {
        if (!job || job.cancelled) continue;
        pending.add(job);
        if (job.running) job.rerun = true;
        else job.nextDue = t;
      }
    }
    if (pending.size > 0) {
      const timer = setTimeout(() => this.endRefresh(), REFRESH_MAX_MS);
      timer.unref();
      this.refreshRound = { startedAt: t, pending, timer };
      this.store.setRefreshing(true);
      this.tick();
    }
    this.log.debug(`Refresh requested: ${pending.size} job(s)`);
    return { accepted: true };
  }

  // --- Test / diagnostics hooks --------------------------------------------

  /** Enqueue every due job and start as many as the semaphore allows. */
  tick(): void {
    if (this.stopped || !this.settings || !this.caReady) return;
    const t = this.now();
    const viewer = this.viewerActive(t);
    for (const entry of this.tiles.values()) {
      for (const job of [entry.status, entry.widget]) {
        if (!job || job.cancelled || job.running || job.queued) continue;
        if (job.kind === "widget" && !viewer) continue;
        if (t >= job.nextDue) {
          job.queued = true;
          this.queue.push(job);
        }
      }
    }
    this.pump();
  }

  /** Resolves once no job is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) {
      await new Promise((r) => setImmediate(r));
    }
  }

  get activeJobs(): number {
    return this.active;
  }

  // --- Config ---------------------------------------------------------------

  private applyConfig(cfg: NormalisedConfig): void {
    if (this.stopped) return;
    const t = this.now();
    const initial = !this.applied;
    this.applied = true;
    this.settings = cfg.settings;
    this.secrets = cfg.secrets;
    // Every config event reloads ca.pem, including events where only ca.pem changed.
    this.reloadCa();
    if (!cfg.settings.tlsVerify || cfg.tiles.some((tl) => tl.widget?.supported && !tl.widget.tlsVerify)) {
      // Wording is quoted in DOCS.md (log lines); keep them in sync.
      this.log.info("TLS verification is off for widget/status requests (settings.yaml tlsVerify)");
    }

    const next = new Map<string, TileEntry>();
    let kept = 0;
    for (const tile of cfg.tiles) {
      if (next.has(tile.id)) continue; // ids are unique by construction; be defensive
      const old = this.tiles.get(tile.id);
      if (old && old.tile.hash === tile.hash) {
        old.tile = tile;
        for (const job of [old.status, old.widget]) {
          if (!job) continue;
          job.tile = tile;
          // Interval settings may have changed: reschedule from the last run.
          if (!job.running && !job.queued && job.finishedAt > 0) job.nextDue = job.finishedAt + this.intervalMs(job);
        }
        next.set(tile.id, old);
        kept++;
        continue;
      }
      if (old) {
        this.cancelEntry(old);
        this.store.deleteTile(tile.id);
      }
      next.set(tile.id, this.createEntry(tile, t, initial));
    }
    for (const [id, entry] of this.tiles) {
      if (!next.has(id)) {
        this.cancelEntry(entry);
        this.store.deleteTile(id);
      }
    }
    this.tiles = next;
    this.store.retain(new Set(next.keys()));
    this.queue = this.queue.filter((j) => !j.cancelled);

    let checks = 0;
    let widgets = 0;
    for (const e of next.values()) {
      if (e.status) checks++;
      if (e.widget) widgets++;
    }
    this.log.info(
      `Scheduling ${checks} status check(s) every ${this.statusIntervalS()} s and ${widgets} widget(s) (${kept} tile(s) unchanged)`,
    );
    this.tick();
  }

  /** Load ca.pem once per config load (WS3 D1). Jobs wait until it is known. */
  private reloadCa(): void {
    const gen = ++this.caGen;
    this.caReady = false;
    Promise.resolve()
      .then(() => this.loadCa(this.ctx.paths.configDir))
      .then(
        (pem) => {
          if (gen !== this.caGen) return;
          this.ca = pem;
          this.caError = undefined;
        },
        (err: unknown) => {
          if (gen !== this.caGen) return;
          this.ca = undefined;
          const msg = err instanceof WidgetError && err.kind === "config" ? err.message : "Can't read ca.pem";
          this.caError = clip(redact(msg, this.secrets));
          this.log.warn(`${this.caError}; HTTPS checks with tlsVerify use the system CAs only, widgets with tlsVerify show a config error`);
        },
      )
      .finally(() => {
        if (gen !== this.caGen) return;
        this.caReady = true;
        this.tick();
      });
  }

  private createEntry(tile: NormalisedTile, t: number, initial: boolean): TileEntry {
    const entry: TileEntry = { tile };
    if (tile.check) {
      const jitter = initial ? Math.floor(this.random() * START_JITTER_MS) : 0;
      entry.status = this.newJob("status", tile, t + jitter);
    }
    const w = tile.widget;
    if (w) {
      const plugin = w.supported ? this.findPlugin(w.type) : undefined;
      if (!w.supported || !plugin) {
        this.store.setWidget(tile.id, { state: "unsupported" });
      } else if (w.configError) {
        const at = new Date(t).toISOString();
        this.store.setWidget(tile.id, {
          state: "error",
          error: { kind: "config", message: redact(w.configError, this.secrets) },
          updatedAt: at,
        });
      } else {
        this.store.setWidget(tile.id, { state: "loading" });
        entry.widget = this.newJob("widget", tile, t);
      }
    }
    return entry;
  }

  private newJob(kind: JobKind, tile: NormalisedTile, nextDue: number): Job {
    return { kind, tileId: tile.id, tile, nextDue, running: false, queued: false, cancelled: false, rerun: false, startedAt: 0, finishedAt: 0 };
  }

  private cancelEntry(entry: TileEntry): void {
    for (const job of [entry.status, entry.widget]) {
      if (!job) continue;
      job.cancelled = true;
      job.controller?.abort();
      this.refreshRound?.pending.delete(job);
    }
    this.maybeEndRefresh();
  }

  // --- Running --------------------------------------------------------------

  private viewerActive(t: number): boolean {
    return t - this.lastViewer < VIEWER_TTL_MS;
  }

  private statusIntervalS(): number {
    return Math.max(MIN_INTERVAL_S, this.settings?.statusIntervalS ?? 30);
  }

  private intervalMs(job: Job): number {
    const s = job.kind === "status" ? this.statusIntervalS() : Math.max(MIN_INTERVAL_S, job.tile.widget?.intervalS ?? 30);
    return s * 1000;
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      job.queued = false;
      if (job.cancelled || this.stopped) continue;
      this.active++;
      job.running = true;
      job.startedAt = this.now();
      job.controller = new AbortController();
      const run = job.kind === "status" ? this.runStatus(job, job.controller) : this.runWidget(job, job.controller);
      run
        .catch((err: unknown) => {
          // runStatus/runWidget handle their own errors; this is a last resort.
          this.log.error(`Internal error in ${job.kind} job`, { tile: job.tile.name, err: redact(String(err), this.secrets) });
        })
        .finally(() => this.finishJob(job));
    }
  }

  private finishJob(job: Job): void {
    this.active--;
    job.running = false;
    job.controller = undefined;
    const t = this.now();
    job.finishedAt = t;
    if (job.rerun) {
      job.rerun = false;
      job.nextDue = t;
    } else {
      job.nextDue = t + this.intervalMs(job);
    }
    const round = this.refreshRound;
    if (round && round.pending.has(job) && job.startedAt >= round.startedAt) {
      round.pending.delete(job);
    }
    if (job.cancelled) this.refreshRound?.pending.delete(job);
    this.maybeEndRefresh();
    this.tick();
  }

  private maybeEndRefresh(): void {
    if (this.refreshRound && this.refreshRound.pending.size === 0) this.endRefresh();
  }

  private endRefresh(): void {
    if (this.refreshRound) clearTimeout(this.refreshRound.timer);
    this.refreshRound = null;
    this.store.setRefreshing(false);
  }

  private async runStatus(job: Job, controller: AbortController): Promise<void> {
    const spec = job.tile.check;
    if (!spec) return;
    let outcome: CheckOutcome;
    try {
      const p =
        spec.kind === "http"
          ? this.runHttpCheck(spec.url, {
              tlsVerify: this.settings?.tlsVerify ?? false,
              ca: this.ca,
              signal: controller.signal,
              secrets: this.secrets,
            })
          : this.runPingCheck(spec.host, { signal: controller.signal });
      outcome = await withDeadline(p, CHECK_GUARD_MS, () => controller.abort());
    } catch (err) {
      if (!(err instanceof TimeoutSignal)) {
        this.log.warn(`Status check for "${job.tile.name}" failed to run`, { err: redact(String(err), this.secrets) });
      }
      outcome = { state: "unknown", kind: spec.kind, reason: "check_failed", detail: err instanceof TimeoutSignal ? "check_timeout" : "internal" };
    }
    if (job.cancelled || this.stopped) return;

    const checkedAt = new Date(this.now()).toISOString();
    const prev = this.store.getStatus(job.tileId);
    const result: StatusResult = { ...outcome, checkedAt };
    if (result.detail !== undefined) result.detail = redact(result.detail, this.secrets);
    if (result.state === "down") result.downSince = prev?.state === "down" && prev.downSince ? prev.downSince : checkedAt;
    this.store.setStatus(job.tileId, result);

    if (prev && prev.state !== result.state) {
      const why = result.reason ? ` (${result.reason}${result.httpStatus ? ` ${result.httpStatus}` : ""})` : "";
      const line = `"${job.tile.name}" is ${result.state}${why}`;
      if (result.state === "up") this.log.info(line);
      else this.log.warn(line);
    } else if (!prev && result.state !== "up") {
      this.log.info(`"${job.tile.name}" is ${result.state} (${result.reason ?? "?"})`);
    }
  }

  private async runWidget(job: Job, controller: AbortController): Promise<void> {
    const w = job.tile.widget;
    if (!w) return;
    const plugin = this.findPlugin(w.type);
    if (!plugin) {
      this.store.setWidget(job.tileId, { state: "unsupported" });
      return;
    }
    const timeoutS = Math.max(1, w.timeoutS);
    let nowPlaying: NowPlayingItem[] | undefined;
    let values: Record<string, WidgetValue> | undefined;
    let error: unknown;
    try {
      const log = this.log.child(w.type);
      if (this.caError && w.tlsVerify) throw new WidgetError("config", this.caError);
      const http = this.createHttpClient(w, { ca: this.ca, signal: controller.signal, secrets: this.secrets, log });
      const ctx: WidgetContext = {
        cfg: Object.freeze({ ...w.cfg }),
        fields: Object.freeze([...w.fields]),
        http,
        signal: controller.signal,
        log,
        net: { tlsVerify: w.tlsVerify, ca: this.ca, timeoutS, secrets: this.secrets },
        setNowPlaying: (items) => {
          nowPlaying = items;
        },
      };
      const deadlineS = Math.max(MIN_RUN_DEADLINE_S, timeoutS * RUN_DEADLINE_FACTOR);
      const raw = await withDeadline(Promise.resolve().then(() => plugin.fetch(ctx)), deadlineS * 1000, () => controller.abort());
      if (!raw || typeof raw !== "object") throw new WidgetError("bad_response", "Plugin returned no values");
      values = {};
      for (const f of w.fields) values[f] = sanitizeValue((raw as Record<string, unknown>)[f]);
    } catch (err) {
      error = err;
    }
    if (job.cancelled || this.stopped) return;

    const at = new Date(this.now()).toISOString();
    const prev = this.store.getWidget(job.tileId);
    if (values) {
      const result: WidgetResult = { state: "ok", values, updatedAt: at, lastOkAt: at };
      if (w.nowPlaying) result.nowPlaying = sanitizeNowPlaying(nowPlaying ?? []);
      this.store.setWidget(job.tileId, result);
      if (prev?.state === "error") this.log.info(`Widget "${job.tile.name}" (${w.type}) recovered`);
      return;
    }

    const e = this.classify(error, w, timeoutS, controller);
    const result: WidgetResult = { state: "error", error: e, updatedAt: at };
    if (prev?.lastOkAt) result.lastOkAt = prev.lastOkAt;
    if (KEEP_VALUES_ON.has(e.kind) && prev?.values) {
      result.values = prev.values;
      if (prev.nowPlaying) result.nowPlaying = prev.nowPlaying;
    }
    this.store.setWidget(job.tileId, result);
    const changed = prev?.state !== "error" || prev.error?.kind !== e.kind;
    const line = `Widget "${job.tile.name}" (${w.type}): ${e.kind}${e.httpStatus ? ` HTTP ${e.httpStatus}` : ""}`;
    const msg = error instanceof Error ? redact(error.message, this.secrets) : undefined;
    if (changed) this.log.warn(line, msg ? { err: msg } : undefined);
    else this.log.debug(line, msg ? { err: msg } : undefined);
  }

  private classify(err: unknown, w: NormalisedWidget, timeoutS: number, controller: AbortController): WidgetResultError {
    const host = widgetHost(w);
    let out: WidgetResultError;
    if (err instanceof WidgetError) {
      out = { kind: err.kind };
      if (err.httpStatus !== undefined) out.httpStatus = err.httpStatus;
      if (err.kind === "config") out.message = clip(redact(err.message, this.secrets));
    } else if (err instanceof TimeoutSignal || (controller.signal.aborted && !this.stopped)) {
      out = { kind: "timeout" };
    } else {
      out = { kind: "bad_response" };
    }
    if (out.kind === "timeout") out.timeoutS = timeoutS;
    if (host) out.host = host;
    return out;
  }
}

/** WS2 factory wired in server.ts. */
export function createScheduler(ctx: BootContext, config: ConfigService, store: Store, deps: SchedulerDeps = {}): Scheduler {
  return new Scheduler(ctx, config, store, deps);
}
