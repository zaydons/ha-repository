// Shared server types for Homelab Dashboard. FROZEN CONTRACT (WS0).
// Every workstream codes against these. Do not change a shape without the
// PM's agreement; additive optional fields are the only "compatible" change.
//
// Rules for all .ts files in this app (Node type stripping, no build step):
// - erasable syntax only (no enum, namespace, parameter properties, decorators);
// - relative imports use the ".ts" extension;
// - type-only imports use `import type`.

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warning" | "error";
export type LogFields = Record<string, unknown>;

/** Every line is passed through redact() with the registered secrets before it is written. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Same sink and level, with a "[scope]" prefix on every line. */
  child(scope: string): Logger;
}

// ---------------------------------------------------------------------------
// Boot context (built by server.ts, handed to every subsystem factory)
// ---------------------------------------------------------------------------

export type ThemeOption = "auto" | "light" | "dark";

/** App options from /data/options.json (set in the HA UI). Nothing else lives there. */
export interface AppOptions {
  theme: ThemeOption;
  log_level: LogLevel;
}

export interface AppPaths {
  /** User config folder (app_config map). "/config" in the container. */
  configDir: string;
  /** App-private data. "/data" in the container. */
  dataDir: string;
  /** Shipped sample files (seeded by entrypoint.sh). */
  sampleDir: string;
  /** Frontend files. */
  webDir: string;
}

export interface BootContext {
  options: AppOptions;
  paths: AppPaths;
  /** Folder shown to the user in copy, e.g. "/addon_configs/f8d8b3af_homelab/" (design §12 Q4). */
  configPathDisplay: string;
  log: Logger;
}

// ---------------------------------------------------------------------------
// Public API types (what the browser receives). Never contain secrets,
// widget blocks or check URLs.
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

export interface ProblemExcerpt {
  startLine: number;
  lines: string[]; // values redacted
  markLine: number;
}

export interface Problem {
  severity: Severity;
  file: string;
  line?: number;
  col?: number;
  /** e.g. "yaml.parse", "item.href", "key.unknown", "widget.unsupported", "secret.missing" */
  code: string;
  /** Already user-facing per the UX copy deck, secrets redacted. */
  message: string;
  tileId?: string;
  excerpt?: ProblemExcerpt;
}

export interface PublicSettings {
  hideNoCheck: boolean;
  groupsInitiallyCollapsed: boolean;
  disableCollapse: boolean;
  statusIntervalS: number;
  widgetIntervalS: number;
}

export interface PublicConfig {
  /** Bumped on every change of the public config, including error-state changes. */
  rev: number;
  title: string;
  theme: ThemeOption;
  /** e.g. "/addon_configs/f8d8b3af_homelab/" */
  configPath: string;
  sampleInUse: boolean;
  /** ISO time the shown groups were loaded. */
  loadedAt: string;
  /** Fatal error for the latest file version (banner). groups = last good, if any. */
  error?: Problem;
  usingLastGood: boolean;
  settings: PublicSettings;
  groups: PublicGroup[];
  problems: Problem[];
}

export interface PublicGroup {
  id: string;
  name: string;
  columns?: number;
  collapsed: boolean;
  /** At most one level deep after normalisation. */
  groups: PublicGroup[];
  tiles: PublicTile[];
}

export type FieldFormat = "number" | "bytes" | "byterate" | "duration" | "percent" | "text";

export interface PublicField {
  key: string;
  label: string;
  format: FieldFormat;
}

export interface PublicWidget {
  type: string;
  supported: boolean;
  hideErrors: boolean;
  /** Labels let the UI draw skeletons before values arrive. */
  fields: PublicField[];
  /**
   * True when this tile also shows a "now playing" list under its stat row
   * (Jellyfin with enableNowPlaying; decisions.md 2026-10-12). Absent = false.
   */
  nowPlaying?: boolean;
}

export interface PublicTile {
  id: string;
  name: string;
  description?: string;
  /** http(s) only; userinfo stripped. Absent = non-link tile. */
  href?: string;
  icon?: IconRef;
  check: "http" | "ping" | "none";
  widget?: PublicWidget;
}

export type IconRef =
  | { kind: "url"; src: string }
  | { kind: "proxied"; src: string /* relative, e.g. "icons/mdi/home.svg" */ }
  | { kind: "letter"; letter: string };

export interface StateSnapshot {
  /** Always equals the current PublicConfig.rev (set by the API layer). */
  rev: number;
  now: string;
  refreshing: boolean;
  /** Keyed by tileId. Tiles without a check have no entry. */
  status: Record<string, StatusResult>;
  /** Keyed by tileId. Tiles without a widget have no entry. */
  widgets: Record<string, WidgetResult>;
}

export type StatusReason =
  | "http"
  | "timeout"
  | "refused"
  | "dns"
  | "tls"
  | "ping"
  | "unreachable"
  | "check_failed";

export interface StatusResult {
  state: "up" | "down" | "unknown";
  kind: "http" | "ping";
  httpStatus?: number;
  latencyMs?: number;
  reason?: StatusReason;
  /** Host only, for UX copy; never a full URL. */
  host?: string;
  /** Short, redacted (e.g. a TLS error code). */
  detail?: string;
  checkedAt: string;
  downSince?: string;
}

export type WidgetErrorKind = "auth" | "unreachable" | "timeout" | "bad_response" | "config";

export type WidgetValue = number | string | null;

export interface WidgetResultError {
  kind: WidgetErrorKind;
  host?: string;
  httpStatus?: number;
  timeoutS?: number;
  /** Only used for kind "config". Redacted. */
  message?: string;
}

/**
 * One active playback session for the "now playing" list. Display text only:
 * no ids, URLs, image links or tokens. The UI renders these as text (never HTML).
 */
export interface NowPlayingItem {
  /** e.g. the movie title, or the episode title. */
  title: string;
  /** e.g. "Show Name · S02E05" or the album/artist. */
  subtitle?: string;
  /** HA-admin-only page, so the media server's user name is acceptable. */
  user?: string;
  /** 0..100. */
  progressPct?: number;
  paused?: boolean;
}

export interface WidgetResult {
  state: "loading" | "ok" | "error" | "unsupported";
  /** Keyed by Homepage field name; null = "not reported". Kept across transient errors. */
  values?: Record<string, WidgetValue>;
  /** Only for tiles with PublicWidget.nowPlaying; [] = nothing playing. Kept/cleared like values. */
  nowPlaying?: NowPlayingItem[];
  error?: WidgetResultError;
  updatedAt?: string;
  lastOkAt?: string;
}

// ---------------------------------------------------------------------------
// Internal normalised config (WS1 produces, WS2/WS3 consume). Contains
// resolved secrets: never serialise to the browser or the log.
// ---------------------------------------------------------------------------

export interface Settings extends PublicSettings {
  title: string;
  /** Global default for widget/status TLS verification. Default false (owner decision Q3). */
  tlsVerify: boolean;
  /** Global default for widget hideErrors. */
  hideErrors: boolean;
}

export type CheckSpec =
  | { kind: "http"; url: string; /** shown in the tooltip only */ ping?: string }
  | { kind: "ping"; host: string };

/** Widget block after secret resolution. Keys are Homepage's. */
export interface WidgetConfig {
  type: string;
  url?: string;
  [k: string]: unknown;
}

export interface NormalisedWidget {
  type: string;
  /** false = unknown type: tile keeps link and status, stats show "unsupported". */
  supported: boolean;
  cfg: WidgetConfig;
  /** Selected field keys, in display order, at most 4. */
  fields: string[];
  tlsVerify: boolean;
  hideErrors: boolean;
  intervalS: number;
  timeoutS: number;
  /** From WidgetPlugin.showsNowPlaying(cfg); copied to PublicWidget.nowPlaying. */
  nowPlaying: boolean;
  /** Set when the block has an item error (e.g. "needs `key:`"): no fetches, result is a config error. */
  configError?: string;
}

export interface NormalisedTile {
  id: string;
  name: string;
  /** Group names from the top level down. */
  groupPath: string[];
  check?: CheckSpec;
  widget?: NormalisedWidget;
  /** Hash of check + widget config, used to keep results across reloads. */
  hash: string;
}

export interface NormalisedConfig {
  rev: number;
  settings: Settings;
  /** Flat list of every rendered tile. */
  tiles: NormalisedTile[];
  /** Every resolved secret value, for redact(). */
  secrets: string[];
}

// ---------------------------------------------------------------------------
// Service interfaces wired together by server.ts. Until a workstream lands,
// server.ts uses the fixture-backed stubs in http/stubs.ts.
// ---------------------------------------------------------------------------

/** WS1: `createConfigService(ctx, plugins, icons)` in src/config/index.ts. */
export interface ConfigService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** What api/config returns. */
  getPublic(): PublicConfig;
  /** Current normalised config with secrets; null before the first good load. */
  getNormalised(): NormalisedConfig | null;
  /** Called after each load that changed the normalised config. Returns an unsubscribe function. */
  onChange(listener: (cfg: NormalisedConfig) => void): () => void;
}

export type RefreshResult = { accepted: true } | { accepted: false; retryAfterS: number };

/** WS2: `createScheduler(ctx, config, store)` in src/scheduler.ts. */
export interface StateService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** rev is filled in by the API layer from ConfigService.getPublic().rev. */
  snapshot(): Omit<StateSnapshot, "rev">;
  /** A viewer polled api/state (drives demand-driven widget polling). */
  noteViewer(): void;
  /** POST api/refresh. Server-side limit 1 per 10 s. */
  requestRefresh(): RefreshResult;
}

export type IconSet = "mdi" | "si" | "di" | "sh" | "local";
export const ICON_SETS: readonly IconSet[] = ["mdi", "si", "di", "sh", "local"];

export interface IconResponse {
  body: Buffer;
  contentType: string;
  /** Defaults to "public, max-age=86400". */
  cacheControl?: string;
}

/** WS6: `createIconService(ctx)` in src/icons/index.ts. */
export interface IconService {
  /** null = 404. `name` already passed the router's basic name check. */
  get(set: IconSet, name: string, query: URLSearchParams): Promise<IconResponse | null>;
  /** WS1 calls this while projecting to turn a Homepage icon string into an IconRef. */
  resolve(icon: string | undefined, serviceName: string): IconRef | undefined;
}
