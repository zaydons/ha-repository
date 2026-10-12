// settings.yaml subset (design §4.3).
import type { Settings } from "../types.ts";
import type { PMap, PNode } from "./parse.ts";
import { scalarText } from "./parse.ts";
import type { Issue } from "./issues.ts";
import { resolveScalar } from "./secrets.ts";
import type { SecretMap } from "./secrets.ts";

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  title: "Homelab",
  hideNoCheck: false,
  groupsInitiallyCollapsed: false,
  disableCollapse: false,
  statusIntervalS: 30,
  widgetIntervalS: 30,
  tlsVerify: false,
  hideErrors: false,
};

export const MIN_INTERVAL_S = 10;
export const MAX_INTERVAL_S = 86_400;
const MAX_COLUMNS = 12;

export interface GroupLayout {
  columns?: number;
  initiallyCollapsed?: boolean;
  line: number;
}

export interface SettingsResult {
  settings: Settings;
  /** Group name → layout, in settings order (Homepage orders groups by it). */
  layout: Map<string, GroupLayout>;
  /** Values seen under `providers` (API keys): always treated as secrets. */
  providerSecrets: string[];
  /** settings.yaml lines holding secret values (masked in excerpts). */
  sensitiveLines: Set<number>;
  issues: Issue[];
}

/** Homepage settings we accept without effect (presentational, or the HA theme wins). */
const SILENT_KEYS = new Set([
  "theme", "color", "background", "backgroundOpacity", "cardBlur", "headerStyle", "favicon", "language", "target",
  "quicklaunch", "base", "useEqualHeights", "fullWidth", "statusStyle", "hideVersion", "logpath", "showStats",
  "description", "startUrl", "maxGroupColumns", "maxBookmarkGroupColumns", "bookmarksStyle", "iconStyle",
  "instanceName", "pwa", "disableIndexing", "disableUpdateCheck", "blockHighlights", "headerstyle", "cardblur",
]);

const FILE = "settings.yaml";

export function readSettings(root: PNode | null, secrets: SecretMap): SettingsResult {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const layout = new Map<string, GroupLayout>();
  const providerSecrets: string[] = [];
  const sensitiveLines = new Set<number>();
  const issues: Issue[] = [];
  if (!root || root.kind !== "map") return { settings, layout, providerSecrets, sensitiveLines, issues };

  const warn = (line: number, col: number, code: string, message: string) =>
    issues.push({ severity: "warning", file: FILE, line, col, code, message });

  const bool = (n: PNode, key: string, line: number, col: number): boolean | undefined => {
    if (n.kind === "scalar" && typeof n.value === "boolean") return n.value;
    warn(line, col, "settings.type", `\`${key}\` must be true or false.`);
    return undefined;
  };

  for (const e of root.entries) {
    const { key, value: v, keyLine: line, keyCol: col } = e;
    switch (key) {
      case "title": {
        if (v.kind === "scalar") {
          const r = resolveScalar(v, secrets);
          if (r.ok && r.value !== null && String(r.value).trim()) settings.title = String(r.value).trim().slice(0, 100);
          else if (!r.ok) warn(line, col, r.code, r.message);
        } else warn(line, col, "settings.type", "`title` must be text.");
        break;
      }
      case "hideNoCheck":
      case "groupsInitiallyCollapsed":
      case "disableCollapse":
      case "tlsVerify":
      case "hideErrors": {
        const b = bool(v, key, line, col);
        if (b !== undefined) settings[key] = b;
        break;
      }
      case "statusInterval":
      case "widgetInterval": {
        const target = key === "statusInterval" ? "statusIntervalS" : "widgetIntervalS";
        if (v.kind === "scalar" && typeof v.value === "number" && Number.isFinite(v.value)) {
          let n = Math.round(v.value);
          if (n < MIN_INTERVAL_S || n > MAX_INTERVAL_S) {
            n = Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, n));
            warn(line, col, "settings.range", `\`${key}\` must be between ${MIN_INTERVAL_S} and ${MAX_INTERVAL_S} seconds; using ${n}.`);
          }
          settings[target] = n;
        } else warn(line, col, "settings.type", `\`${key}\` must be a number of seconds.`);
        break;
      }
      case "layout":
        readLayout(v, layout, issues);
        break;
      case "providers":
        collectStrings(v, providerSecrets, secrets, sensitiveLines);
        issues.push({
          severity: "info",
          file: FILE,
          line,
          col,
          code: "key.ignored",
          message: "Ignored `providers` in settings.yaml: not supported in v1. Put the key in the widget or in secrets.yaml.",
        });
        break;
      default:
        if (!SILENT_KEYS.has(key)) {
          issues.push({ severity: "info", file: FILE, line, col, code: "key.unknown", message: `Unknown setting \`${key}\` (ignored).` });
        }
    }
  }
  return { settings, layout, providerSecrets, sensitiveLines, issues };
}

function collectStrings(n: PNode, out: string[], secrets: SecretMap, lines: Set<number>): void {
  for (let l = n.line; l <= Math.max(n.line, n.endLine); l++) lines.add(l);
  if (n.kind === "scalar") {
    const r = resolveScalar(n, secrets);
    const t = r.ok && r.value !== null ? String(r.value) : scalarText(n);
    if (t) out.push(t);
  } else if (n.kind === "map") for (const e of n.entries) collectStrings(e.value, out, secrets, lines);
  else for (const it of n.items) collectStrings(it, out, secrets, lines);
}

function readLayout(v: PNode, layout: Map<string, GroupLayout>, issues: Issue[]): void {
  // Homepage allows a map ({Group: {...}}) or a list of single-key maps.
  const entries: { key: string; line: number; col: number; value: PNode }[] = [];
  if (v.kind === "map") for (const e of v.entries) entries.push({ key: e.key, line: e.keyLine, col: e.keyCol, value: e.value });
  else if (v.kind === "seq") {
    for (const it of v.items) {
      if (it.kind === "map") for (const e of it.entries) entries.push({ key: e.key, line: e.keyLine, col: e.keyCol, value: e.value });
    }
  } else if (v.value !== null) {
    issues.push({ severity: "warning", file: FILE, line: v.line, col: v.col, code: "settings.type", message: "`layout` must be a map of group names." });
    return;
  }
  for (const e of entries) {
    const gl: GroupLayout = { line: e.line };
    if (e.value.kind === "map") readGroupLayout(e.key, e.value, gl, issues);
    layout.set(e.key, gl);
  }
}

function readGroupLayout(group: string, m: PMap, gl: GroupLayout, issues: Issue[]): void {
  for (const e of m.entries) {
    const v = e.value;
    if (e.key === "columns") {
      if (v.kind === "scalar" && typeof v.value === "number" && Number.isInteger(v.value) && v.value >= 1 && v.value <= MAX_COLUMNS) {
        gl.columns = v.value;
      } else {
        issues.push({ severity: "warning", file: FILE, line: e.keyLine, col: e.keyCol, code: "settings.type", message: `\`columns\` for "${group}" must be a whole number from 1 to ${MAX_COLUMNS}.` });
      }
    } else if (e.key === "initiallyCollapsed") {
      if (v.kind === "scalar" && typeof v.value === "boolean") gl.initiallyCollapsed = v.value;
      else issues.push({ severity: "warning", file: FILE, line: e.keyLine, col: e.keyCol, code: "settings.type", message: "`initiallyCollapsed` must be true or false." });
    }
    // style, icon, header, tab, rows, useEqualHeights...: accepted silently (presentational).
  }
}
