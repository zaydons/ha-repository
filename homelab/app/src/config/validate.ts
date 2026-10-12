// services.yaml validation and normalisation (design §4.2, §4.5, §4.7 tileId).
// Produces the internal tiles (with secrets) and the public group tree (without).
import { createHash } from "node:crypto";
import type {
  CheckSpec,
  IconService,
  NormalisedTile,
  NormalisedWidget,
  PublicField,
  PublicGroup,
  PublicTile,
  PublicWidget,
  Settings,
  WidgetConfig,
} from "../types.ts";
import type { WidgetPlugin } from "../widgets/types.ts";
import type { Issue } from "./issues.ts";
import type { PMap, PNode, PScalar } from "./parse.ts";
import { scalarText } from "./parse.ts";
import { resolveScalar } from "./secrets.ts";
import type { SecretMap } from "./secrets.ts";
import type { GroupLayout } from "./settings.ts";
import { MIN_INTERVAL_S } from "./settings.ts";
import { checkPingHost, checkUrl, isIconName, sanitiseIconRef, urlSecrets, withoutUserinfo } from "./urls.ts";

const FILE = "services.yaml";
export const MAX_FIELDS = 4;
export const DEFAULT_TIMEOUT_S = 10;

/** Widget keys whose values are secrets regardless of the plugin's declaration. */
export const SECRET_VALUE_KEY_RE = /^(key|api_?key|token|access_?token|password|pass|username|user|secret|client_?secret)$/i;

/** Accepted on every widget block (design §4.2). */
const UNIVERSAL_WIDGET_KEYS = new Set(["type", "url", "fields", "hideErrors", "tlsVerify", "headers"]);
/** Widget values read as text even when YAML parses them as numbers ("0123"). */
const TEXT_WIDGET_KEYS = new Set(["url", "key", "username", "password", "token", "apikey", "api_key"]);

/** Plugin keys that are accepted but have no effect in v1: info note when enabled. */
const INFO_WIDGET_KEYS: Record<string, Record<string, string>> = {
  sonarr: { enableQueue: "the queue list isn't supported yet" },
  radarr: { enableQueue: "the queue list isn't supported yet" },
  jellyfin: { enableMediaControl: "media controls aren't supported" },
  truenas: { enablePools: "the pools list isn't supported yet" },
};

const SILENT_SERVICE_KEYS = new Set(["target", "statusStyle", "showStats", "weight", "id"]);
const DISCOVERY_KEYS: Record<string, string> = {
  server: "Docker integration isn't supported",
  container: "Docker integration isn't supported",
  app: "Kubernetes integration isn't supported",
  namespace: "Kubernetes integration isn't supported",
  podSelector: "Kubernetes integration isn't supported",
  proxmoxNode: "Proxmox integration isn't supported",
};

export interface ServicesInput {
  root: PNode | null;
  settings: Settings;
  layout: ReadonlyMap<string, GroupLayout>;
  secrets: SecretMap;
  plugins: readonly WidgetPlugin[];
  icons: Pick<IconService, "resolve">;
}

export interface ServicesResult {
  groups: PublicGroup[];
  tiles: NormalisedTile[];
  issues: Issue[];
  /** Values found at secret positions (widget keys, headers, URL credentials). Never shown. */
  hardSecrets: Set<string>;
  /** Other values that came from secrets.yaml (redacted in logs). */
  softSecrets: Set<string>;
  /** services.yaml lines holding secret values (masked in excerpts). */
  sensitiveLines: Set<number>;
  counts: { groups: number; services: number; widgets: number };
}

interface RawGroup {
  name: string;
  path: string[];
  line: number;
  tiles: PublicTile[];
  children: RawGroup[];
}

export function sha1Hex(s: string, n = 12): string {
  return createHash("sha1").update(s).digest("hex").slice(0, n);
}

/** Design §4.7: stable across reloads. */
export function tileIdFor(groupPath: readonly string[], name: string, occurrence: number): string {
  return sha1Hex(`${groupPath.join("\u0000")}\u0000${name}\u0000${occurrence}`);
}

export function groupIdFor(path: readonly string[], occurrence: number): string {
  return `g-${sha1Hex(`${path.join("\u0000")}\u0000${occurrence}`)}`;
}

export function validateServices(input: ServicesInput): ServicesResult {
  const issues: Issue[] = [];
  const hardSecrets = new Set<string>();
  const softSecrets = new Set<string>();
  const sensitiveLines = new Set<number>();
  const tiles: NormalisedTile[] = [];
  const occurrences = new Map<string, number>();
  const unsupportedReported = new Set<string>();
  const { settings, secrets, plugins } = input;

  const issue = (severity: Issue["severity"], line: number | undefined, col: number | undefined, code: string, message: string, tileId?: string) => {
    const i: Issue = { severity, file: FILE, code, message };
    if (line !== undefined) i.line = line;
    if (col !== undefined) i.col = col;
    if (tileId !== undefined) i.tileId = tileId;
    issues.push(i);
  };
  const markLines = (n: { line: number; endLine: number }) => {
    for (let l = n.line; l <= Math.max(n.line, n.endLine); l++) sensitiveLines.add(l);
  };
  const addHard = (v: string) => {
    if (v) hardSecrets.add(v);
  };

  /** Resolve a scalar to text for a tile key; records problems. undefined = unusable. */
  const text = (n: PNode, key: string, tileId: string, opts: { secretPosition?: boolean } = {}): string | undefined => {
    if (n.kind !== "scalar") {
      issue("warning", n.line, n.col, "key.type", `\`${key}\` must be a single value.`, tileId);
      return undefined;
    }
    const r = resolveScalar(n, secrets);
    if (!r.ok) {
      markLines(n);
      issue("warning", n.line, n.col, r.code, r.message, tileId);
      return undefined;
    }
    if (r.value === null) return undefined;
    const s = typeof r.value === "string" ? r.value : (scalarText(n as PScalar) ?? String(r.value));
    if (r.fromSecret) {
      markLines(n);
      softSecrets.add(s);
    }
    if (opts.secretPosition) {
      markLines(n);
      addHard(s);
    }
    return s;
  };

  const buildTile = (name: string, nameLine: number, nameCol: number, body: PNode | null, groupPath: string[]): PublicTile => {
    const occKey = `${groupPath.join("\u0000")}\u0000${name}`;
    const occ = occurrences.get(occKey) ?? 0;
    occurrences.set(occKey, occ + 1);
    const id = tileIdFor(groupPath, name, occ);
    const pub: PublicTile = { id, name, check: "none" };
    let check: CheckSpec | undefined;
    let siteMonitor: string | undefined;
    let pingHost: string | undefined;
    let iconText: string | undefined;
    const widgetNodes: PNode[] = [];

    if (body && body.kind === "scalar" && body.value !== null) {
      issue("warning", body.line, body.col, "item.invalid", `"${name}" should have its settings (href, icon...) indented under it.`, id);
    } else if (body && body.kind === "seq") {
      // handled by the caller as a nested group
    } else if (body && body.kind === "map") {
      for (const e of body.entries) {
        const v = e.value;
        switch (e.key) {
          case "icon":
            iconText = text(v, "icon", id);
            break;
          case "href": {
            const s = text(v, "href", id);
            if (s === undefined) break;
            const c = checkUrl(s);
            if (!c) {
              issue("warning", v.line, v.col, "item.href", `\`href\` isn't a valid http(s) URL, so this tile isn't a link.`, id);
              break;
            }
            if (c.hadUserinfo) {
              for (const x of urlSecrets(c.url)) addHard(x);
              markLines(v);
              issue("warning", v.line, v.col, "item.href.userinfo", "Removed the user name and password from `href`. Links can't carry credentials.", id);
            }
            pub.href = withoutUserinfo(c.url);
            break;
          }
          case "description": {
            const s = text(v, "description", id);
            if (s !== undefined && s.trim()) pub.description = s.trim().slice(0, 500);
            break;
          }
          case "siteMonitor": {
            const s = text(v, "siteMonitor", id);
            if (s === undefined) break;
            const c = checkUrl(s);
            if (!c) {
              issue("warning", v.line, v.col, "item.siteMonitor", "`siteMonitor` isn't a valid http(s) URL, so there's no status check.", id);
              break;
            }
            for (const x of urlSecrets(c.url)) addHard(x);
            if (c.hadUserinfo) markLines(v);
            siteMonitor = c.url.href;
            break;
          }
          case "ping": {
            const s = text(v, "ping", id);
            if (s === undefined) break;
            const h = checkPingHost(s);
            if (!h) {
              issue("warning", v.line, v.col, "item.ping", "`ping` must be a host name or IP address.", id);
              break;
            }
            pingHost = h;
            break;
          }
          case "widget":
            widgetNodes.unshift(v);
            break;
          case "widgets":
            if (v.kind === "seq") widgetNodes.push(...v.items);
            else if (!(v.kind === "scalar" && v.value === null)) issue("warning", v.line, v.col, "key.type", "`widgets` must be a list.", id);
            break;
          default:
            if (SILENT_SERVICE_KEYS.has(e.key)) break;
            if (e.key in DISCOVERY_KEYS) {
              issue("info", e.keyLine, e.keyCol, "key.ignored", `Ignored \`${e.key}\` in ${FILE} line ${e.keyLine}: ${DISCOVERY_KEYS[e.key]}.`, id);
              break;
            }
            issue("warning", e.keyLine, e.keyCol, "key.unknown", `Unknown key \`${e.key}\`.`, id);
        }
      }
    }

    if (siteMonitor && pingHost) {
      const pe = body?.kind === "map" ? body.entries.find((x) => x.key === "ping") : undefined;
      issue("info", pe?.keyLine, pe?.keyCol, "key.ignored", `Ignored \`ping\` in ${FILE} line ${pe?.keyLine ?? "?"}: a tile shows one status in v1, so \`siteMonitor\` is used.`, id);
    }
    if (siteMonitor) {
      check = pingHost ? { kind: "http", url: siteMonitor, ping: pingHost } : { kind: "http", url: siteMonitor };
      pub.check = "http";
    } else if (pingHost) {
      check = { kind: "ping", host: pingHost };
      pub.check = "ping";
    }

    // Icons: only validated names or http(s) URLs reach the icon service (threat model R3).
    let iconInput: string | undefined;
    if (iconText !== undefined) {
      const t = iconText.trim();
      if (isIconName(t)) iconInput = t;
      else {
        const c = checkUrl(t);
        if (c && !c.hadUserinfo) iconInput = c.url.href;
        else issue("warning", nameLine, nameCol, "item.icon", "`icon` isn't a known icon name or an http(s) URL; showing a letter instead.", id);
      }
    }
    const icon = sanitiseIconRef(input.icons.resolve(iconInput, name), name);
    if (icon) pub.icon = icon;

    let widget: NormalisedWidget | undefined;
    if (widgetNodes.length > 0) {
      const built = widgetNodes.map((n) => buildWidget(n, id));
      const chosen = built.find((w) => w?.supported) ?? built.find((w) => w !== undefined);
      const extra = built.filter((w) => w !== undefined && w !== chosen).length;
      if (extra > 0) {
        issue("info", widgetNodes[0]!.line, widgetNodes[0]!.col, "widget.multiple", `Only one widget per tile in v1; showing "${chosen?.type ?? "?"}" and ignoring ${extra} more.`, id);
      }
      if (chosen) {
        widget = chosen;
        const plugin = plugins.find((p) => p.type === chosen.type);
        const fields: PublicField[] = [];
        for (const k of chosen.fields) {
          const f = plugin?.fields.find((x) => x.key === k);
          if (f) fields.push({ key: f.key, label: f.label, format: f.format });
        }
        const pw: PublicWidget = { type: chosen.type, supported: chosen.supported, hideErrors: chosen.hideErrors, fields };
        if (chosen.nowPlaying) pw.nowPlaying = true;
        pub.widget = pw;
      }
    }

    const tile: NormalisedTile = { id, name, groupPath: [...groupPath], hash: "" };
    if (check) tile.check = check;
    if (widget) tile.widget = widget;
    tile.hash = sha1Hex(JSON.stringify({ check: check ?? null, widget: widget ?? null }), 40);
    tiles.push(tile);
    return pub;
  };

  const buildWidget = (n: PNode, tileId: string): NormalisedWidget | undefined => {
    if (n.kind !== "map") {
      issue("warning", n.line, n.col, "widget.config", "`widget` must be a block with at least `type:`.", tileId);
      return undefined;
    }
    const typeEntry = n.entries.find((e) => e.key === "type");
    const typeText = typeEntry ? text(typeEntry.value, "type", tileId) : undefined;
    const type = typeText?.trim() ?? "";
    if (!type) {
      issue("warning", n.line, n.col, "widget.config", "This widget needs `type:`.", tileId);
      return undefined;
    }
    const plugin = plugins.find((p) => p.type === type);
    const base = {
      type,
      tlsVerify: settings.tlsVerify,
      hideErrors: settings.hideErrors,
      intervalS: Math.max(MIN_INTERVAL_S, settings.widgetIntervalS),
      timeoutS: DEFAULT_TIMEOUT_S,
      nowPlaying: false,
    };

    // Every value in the block is checked for secrets, even for unsupported types,
    // so a key in an unsupported widget still never reaches the log.
    const secretKeys = new Set(plugin?.configKeys.secret ?? []);
    const cfg: WidgetConfig = { type };
    let configError: string | undefined;
    const fail = (line: number, col: number, code: string, message: string) => {
      issue("warning", line, col, code, message, tileId);
      configError ??= message;
    };

    const resolveDeep = (node: PNode, key: string, secretPos: boolean): unknown => {
      if (node.kind === "scalar") {
        const r = resolveScalar(node, secrets);
        if (!r.ok) {
          markLines(node);
          fail(node.line, node.col, r.code, r.message);
          return undefined;
        }
        let v = r.value;
        if (typeof v === "number" && (secretPos || TEXT_WIDGET_KEYS.has(key))) v = scalarText(node) ?? String(v);
        if (typeof v === "string") {
          if (r.fromSecret) {
            markLines(node);
            softSecrets.add(v);
          }
          if (secretPos) {
            markLines(node);
            addHard(v);
          }
        }
        return v;
      }
      if (node.kind === "seq") return node.items.map((it) => resolveDeep(it, key, secretPos));
      const obj: Record<string, unknown> = {};
      for (const e of node.entries) obj[e.key] = resolveDeep(e.value, e.key, secretPos || SECRET_VALUE_KEY_RE.test(e.key));
      return obj;
    };

    for (const e of n.entries) {
      if (e.key === "type") continue;
      const secretPos = secretKeys.has(e.key) || SECRET_VALUE_KEY_RE.test(e.key) || e.key === "headers";
      const v = resolveDeep(e.value, e.key, secretPos);
      if (v !== undefined) cfg[e.key] = v;
    }

    if (!plugin) {
      if (!unsupportedReported.has(type)) {
        unsupportedReported.add(type);
        issue("info", typeEntry?.value.line ?? n.line, typeEntry?.value.col ?? n.col, "widget.unsupported", `The "${type}" widget isn't supported yet. This tile still works as a link.`, tileId);
      }
      // The raw block never leaves the server; unsupported widgets keep only their type.
      return { ...base, supported: false, cfg: { type }, fields: [] };
    }

    const known = new Set([...UNIVERSAL_WIDGET_KEYS, ...plugin.configKeys.required, ...plugin.configKeys.optional, ...plugin.configKeys.secret]);
    for (const e of n.entries) {
      if (!known.has(e.key)) {
        issue("warning", e.keyLine, e.keyCol, "widget.key.unknown", `Unknown setting "${e.key}" for the ${type} widget.`, tileId);
      }
      const info = INFO_WIDGET_KEYS[type]?.[e.key];
      if (info && cfg[e.key] !== false && cfg[e.key] !== undefined) {
        issue("info", e.keyLine, e.keyCol, "key.ignored", `Ignored \`${e.key}\` in ${FILE} line ${e.keyLine}: ${info}.`, tileId);
      }
    }

    // url: required unless the plugin lists it as optional.
    const urlRequired = !plugin.configKeys.optional.includes("url");
    const urlEntry = n.entries.find((e) => e.key === "url");
    if (cfg.url === undefined || cfg.url === null || cfg.url === "") {
      delete cfg.url;
      if (urlRequired && !(urlEntry && configError)) fail(n.line, n.col, "widget.config", `The ${type} widget needs \`url:\`.`);
    } else if (typeof cfg.url !== "string" || !checkUrl(cfg.url)) {
      fail(urlEntry?.value.line ?? n.line, urlEntry?.value.col ?? n.col, "widget.config", `The ${type} widget's \`url\` isn't a valid http(s) URL.`);
    } else {
      const c = checkUrl(cfg.url)!;
      for (const x of urlSecrets(c.url)) addHard(x);
      if (c.hadUserinfo && urlEntry) markLines(urlEntry.value);
      // Review N7: TrueNAS v1 (REST) over plain http sends the key in clear,
      // and TrueNAS 25.04+ revokes a key used that way.
      const version = cfg.version === undefined || cfg.version === null ? 1 : Number(cfg.version);
      if (type === "truenas" && version === 1 && c.url.protocol === "http:" && cfg.key) {
        issue(
          "info",
          urlEntry?.value.line ?? n.line,
          urlEntry?.value.col ?? n.col,
          "widget.insecure",
          "This TrueNAS widget sends its API key over plain http (version 1). TrueNAS 25.04 and later revoke keys used that way: use an https:// url or `version: 2`.",
          tileId,
        );
      }
    }

    for (const req of plugin.configKeys.required) {
      if (req === "url" || req === "type") continue;
      const v = cfg[req];
      if (v === undefined || v === null || v === "") {
        const entry = n.entries.find((e) => e.key === req);
        if (!(entry && configError)) fail(n.line, n.col, "widget.config", `The ${type} widget needs \`${req}:\`.`);
      }
    }

    let hideErrors = settings.hideErrors;
    if (cfg.hideErrors !== undefined) {
      if (typeof cfg.hideErrors === "boolean") hideErrors = cfg.hideErrors;
      else issue("warning", n.line, n.col, "widget.key.type", "`hideErrors` must be true or false.", tileId);
    }
    let tlsVerify = settings.tlsVerify;
    if (cfg.tlsVerify !== undefined) {
      if (typeof cfg.tlsVerify === "boolean") tlsVerify = cfg.tlsVerify;
      else issue("warning", n.line, n.col, "widget.key.type", "`tlsVerify` must be true or false.", tileId);
    }
    if (cfg.headers !== undefined) {
      const h = cfg.headers;
      const ok = h !== null && typeof h === "object" && !Array.isArray(h) && Object.values(h).every((x) => typeof x === "string" || typeof x === "number");
      if (!ok) fail(n.line, n.col, "widget.config", "`headers` must be a map of header names to values.");
    }

    // Fields (design §4.5): config order, known only, first 4; else defaults.
    const fieldsEntry = n.entries.find((e) => e.key === "fields");
    let requested: string[] | undefined;
    if (cfg.fields !== undefined && cfg.fields !== null) {
      let raw: unknown = cfg.fields;
      if (typeof raw === "string") {
        const t = raw.trim();
        if (t.startsWith("[")) {
          try {
            raw = JSON.parse(t);
          } catch {
            raw = [t];
          }
        } else raw = t.split(",").map((x) => x.trim()).filter(Boolean);
      }
      if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) requested = raw as string[];
      else issue("warning", fieldsEntry?.keyLine ?? n.line, fieldsEntry?.keyCol ?? n.col, "widget.field", "`fields` must be a list of field names.", tileId);
    }
    let fields: string[];
    if (requested) {
      const allowed = new Set(plugin.fields.map((f) => f.key));
      const good: string[] = [];
      for (const f of requested) {
        if (!allowed.has(f)) {
          issue("warning", fieldsEntry?.keyLine ?? n.line, fieldsEntry?.keyCol ?? n.col, "widget.field", `Unknown field "${f}" for the ${type} widget. Known: ${[...allowed].join(", ")}.`, tileId);
        } else if (!good.includes(f)) good.push(f);
      }
      if (good.length > MAX_FIELDS) {
        issue("info", fieldsEntry?.keyLine ?? n.line, fieldsEntry?.keyCol ?? n.col, "widget.field", `Only ${MAX_FIELDS} fields fit on a tile; showing ${good.slice(0, MAX_FIELDS).join(", ")}.`, tileId);
      }
      fields = good.length > 0 ? good.slice(0, MAX_FIELDS) : plugin.defaultFields.slice(0, MAX_FIELDS);
    } else fields = plugin.defaultFields.slice(0, MAX_FIELDS);
    // Plugin hook (e.g. Jellyfin enableBlocks: false → no stat row). Results are
    // kept to known fields and the 4-field cap.
    if (plugin.selectFields) {
      try {
        const picked = plugin.selectFields(cfg, fields);
        if (Array.isArray(picked)) {
          const allowed = new Set(plugin.fields.map((f) => f.key));
          fields = picked.filter((f) => typeof f === "string" && allowed.has(f)).slice(0, MAX_FIELDS);
        }
      } catch (err) {
        issue("warning", n.line, n.col, "widget.field", `The ${type} widget couldn't pick its fields (${err instanceof Error ? err.name : "error"}); showing the defaults.`, tileId);
      }
    }

    if (!configError && plugin.validate) {
      let msg: string | null = null;
      try {
        msg = plugin.validate(cfg);
      } catch (err) {
        msg = `The ${type} widget settings couldn't be checked (${err instanceof Error ? err.name : "error"}).`;
      }
      if (msg) fail(n.line, n.col, "widget.config", msg);
    }

    let nowPlaying = false;
    try {
      nowPlaying = plugin.showsNowPlaying ? plugin.showsNowPlaying(cfg) === true : false;
    } catch {
      nowPlaying = false;
    }

    const w: NormalisedWidget = {
      ...base,
      supported: true,
      cfg,
      fields,
      tlsVerify,
      hideErrors,
      intervalS: Math.max(MIN_INTERVAL_S, plugin.intervalS ?? settings.widgetIntervalS),
      timeoutS: plugin.timeoutS ?? DEFAULT_TIMEOUT_S,
      nowPlaying,
    };
    if (configError) w.configError = configError;
    return w;
  };

  /** Items inside a group: services or nested groups. */
  const walkGroupItems = (items: PNode[], group: RawGroup) => {
    for (const item of items) {
      if (item.kind !== "map" || item.entries.length === 0) {
        if (!(item.kind === "scalar" && item.value === null)) {
          issue("warning", item.line, item.col, "item.invalid", `Each item in "${group.name}" must be "- Name:" followed by its settings.`);
        }
        continue;
      }
      if (item.entries.length > 1) {
        const keys = item.entries.slice(0, 3).map((e) => `\`${e.key}\``).join(", ");
        issue("warning", item.line, item.col, "item.invalid", `Expected one service name in this list item but found ${item.entries.length} keys (${keys}). Check the indentation.`);
        continue;
      }
      const e = item.entries[0]!;
      const name = e.key.trim();
      if (!name) {
        issue("warning", e.keyLine, e.keyCol, "item.name", "This service has no name, so it was skipped.");
        continue;
      }
      if (e.value.kind === "seq") {
        const child: RawGroup = { name, path: [...group.path, name], line: e.keyLine, tiles: [], children: [] };
        group.children.push(child);
        walkGroupItems(e.value.items, child);
        continue;
      }
      group.tiles.push(buildTile(name, e.keyLine, e.keyCol, e.value, group.path));
    }
  };

  const top: RawGroup[] = [];
  if (input.root && input.root.kind === "seq") {
    for (const item of input.root.items) {
      if (item.kind !== "map") {
        if (!(item.kind === "scalar" && item.value === null)) {
          issue("warning", item.line, item.col, "group.invalid", 'Each top-level item must be a group: "- Group name:" followed by a list of services.');
        }
        continue;
      }
      for (const e of item.entries) {
        const name = e.key.trim();
        if (!name) {
          issue("warning", e.keyLine, e.keyCol, "group.invalid", "This group has no name, so it was skipped.");
          continue;
        }
        const g: RawGroup = { name, path: [name], line: e.keyLine, tiles: [], children: [] };
        if (e.value.kind === "seq") walkGroupItems(e.value.items, g);
        else if (e.value.kind === "map") {
          issue("warning", e.value.line, e.value.col, "group.invalid", `Services in "${name}" must be a list: start each one with "- ".`);
          continue;
        } else if (e.value.value !== null) {
          issue("warning", e.value.line, e.value.col, "group.invalid", `"${name}" must be followed by a list of services.`);
          continue;
        }
        top.push(g);
      }
    }
  }

  const groups = finishGroups(top, input.layout, settings);
  const services = tiles.length;
  const widgets = tiles.filter((t) => t.widget?.supported).length;
  return { groups, tiles, issues, hardSecrets, softSecrets, sensitiveLines, counts: { groups: groups.length, services, widgets } };
}

/** Flatten to one nesting level, apply layout (order, columns, collapsed), assign ids. */
function finishGroups(top: RawGroup[], layout: ReadonlyMap<string, GroupLayout>, settings: Settings): PublicGroup[] {
  const idCounts = new Map<string, number>();
  const idFor = (path: string[]) => {
    const k = path.join("\u0000");
    const n = idCounts.get(k) ?? 0;
    idCounts.set(k, n + 1);
    return groupIdFor(path, n);
  };
  const collectDeep = (g: RawGroup): PublicTile[] => [...g.tiles, ...g.children.flatMap(collectDeep)];
  const decorate = (g: RawGroup, pg: PublicGroup) => {
    const l = layout.get(g.name);
    if (l?.columns !== undefined) pg.columns = l.columns;
    pg.collapsed = !settings.disableCollapse && (l?.initiallyCollapsed ?? settings.groupsInitiallyCollapsed);
    return pg;
  };
  const order = [...layout.keys()];
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i < 0 ? order.length : i;
  };
  const sorted = top.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g.name) - rank(b.g.name) || a.i - b.i).map((x) => x.g);
  return sorted.map((g) =>
    decorate(g, {
      id: idFor(g.path),
      name: g.name,
      collapsed: false,
      tiles: g.tiles,
      groups: g.children.map((c) => decorate(c, { id: idFor(c.path), name: c.name, collapsed: false, groups: [], tiles: collectDeep(c) })),
    }),
  );
}
