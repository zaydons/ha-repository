// Widget plugin contract. FROZEN CONTRACT (WS0). Design §4.5.
// One file per widget type implements WidgetPlugin; WS3 implements HttpClient.
import type { FieldFormat, Logger, NowPlayingItem, WidgetConfig, WidgetErrorKind, WidgetValue } from "../types.ts";

export type { NowPlayingItem, WidgetConfig, WidgetErrorKind, WidgetValue } from "../types.ts";

export interface FieldDef {
  /** Homepage field name, e.g. "wanted". */
  key: string;
  /** Homepage English label, e.g. "Wanted". */
  label: string;
  format: FieldFormat;
}

export interface WidgetConfigKeys {
  required: string[];
  optional: string[];
  /** Values of these keys are secrets: redacted everywhere. */
  secret: string[];
}

export interface WidgetPlugin {
  /** Homepage widget type, e.g. "sonarr". */
  type: string;
  /** Every allowed field, Homepage names, display order. */
  fields: FieldDef[];
  /** Used when the config has no `fields:` (at most 4). */
  defaultFields: string[];
  configKeys: WidgetConfigKeys;
  /** Default settings.widgetInterval (30); minimum 10. */
  intervalS?: number;
  /** Default 10. */
  timeoutS?: number;
  /** Extra checks, e.g. "needs key or username+password". Returns a user-facing message or null. */
  validate?(cfg: WidgetConfig): string | null;
  /**
   * Whether this config shows a "now playing" list (e.g. Jellyfin's
   * enableNowPlaying, default true as in Homepage). Absent = never.
   * When true, fetch() should call ctx.setNowPlaying() on every success.
   */
  showsNowPlaying?(cfg: WidgetConfig): boolean;
  /**
   * Optional last say over the stat fields a tile shows, applied by the config
   * engine after its normal selection (`fields:` or defaultFields, max 4).
   * Returns a subset of `selected`, in order. Absent = `selected` unchanged.
   * E.g. Jellyfin returns [] when `enableBlocks` is false (Homepage parity:
   * no stat blocks, only the now-playing list).
   */
  selectFields?(cfg: WidgetConfig, selected: readonly string[]): string[];
  /** Only the requested fields need values; missing optional values are null. Throws WidgetError. */
  fetch(ctx: WidgetContext): Promise<Record<string, WidgetValue>>;
}

export interface WidgetContext {
  /** Secrets already resolved. */
  cfg: Readonly<WidgetConfig>;
  /** The fields the tile shows; skip API calls that aren't needed. */
  fields: readonly string[];
  http: HttpClient;
  signal: AbortSignal;
  log: Logger;
  /**
   * Reports the "now playing" list from the same round as the values (so one
   * sessions call feeds both the "playing" count and the list). Provided by
   * the scheduler; a no-op for tiles without a list. Last call wins.
   */
  setNowPlaying(items: NowPlayingItem[]): void;
}

export interface ReqOpts {
  method?: "GET" | "POST" | "HEAD";
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  /** JSON-encoded. */
  body?: unknown;
  accept?: string;
  /** Statuses treated as success in addition to 2xx. */
  okStatuses?: number[];
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Bound to cfg.url, the TLS policy, cfg.headers and the timeout.
 * Paths are joined to cfg.url (keeping its sub-path); absolute URLs are refused;
 * redirects are not followed (3xx = bad_response); bodies are capped at 10 MB.
 * Errors are thrown as WidgetError with the central mapping (design §4.5).
 */
export interface HttpClient {
  json<T = unknown>(path: string, opts?: ReqOpts): Promise<T>;
  text(path: string, opts?: ReqOpts): Promise<string>;
  raw(path: string, opts?: ReqOpts): Promise<RawResponse>;
}

export class WidgetError extends Error {
  kind: WidgetErrorKind;
  httpStatus: number | undefined;
  /** Short redacted detail, e.g. a TLS error code. */
  detail: string | undefined;

  constructor(kind: WidgetErrorKind, message: string, httpStatus?: number, detail?: string) {
    super(message);
    this.name = "WidgetError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}
