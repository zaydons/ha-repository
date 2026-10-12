// Public projection (design §4.8, threat model R6): what api/config returns.
// No widget blocks, no check URLs, no credentials. As a backstop, every string
// is scrubbed of secret-position values (e.g. a key pasted into a description).
import type { Problem, PublicConfig, PublicGroup, PublicTile, Settings, ThemeOption } from "../types.ts";
import { redact } from "../redact.ts";
import { checkUrl, sanitiseIconRef, withoutUserinfo } from "./urls.ts";

export interface ProjectionInput {
  rev: number;
  theme: ThemeOption;
  configPath: string;
  sampleInUse: boolean;
  loadedAt: string;
  settings: Settings;
  groups: PublicGroup[];
  problems: Problem[];
  error?: Problem;
  usingLastGood: boolean;
  hardSecrets: readonly string[];
}

export function project(input: ProjectionInput): PublicConfig {
  const scrub = (s: string) => redact(s, input.hardSecrets);

  const tile = (t: PublicTile): PublicTile => {
    const out: PublicTile = { id: t.id, name: scrub(t.name), check: t.check };
    if (t.description !== undefined) out.description = scrub(t.description);
    if (t.href !== undefined) {
      // R2: re-checked here so nothing but http(s) without userinfo is ever projected.
      const c = checkUrl(t.href);
      if (c) {
        const href = withoutUserinfo(c.url);
        if (scrub(href) === href) out.href = href;
      }
    }
    const icon = sanitiseIconRef(t.icon, out.name);
    if (icon) {
      if (icon.kind === "url" && scrub(icon.src) !== icon.src) {
        const fallback = sanitiseIconRef(undefined, out.name);
        if (fallback) out.icon = fallback;
      } else out.icon = icon;
    }
    if (t.widget) {
      out.widget = {
        type: scrub(t.widget.type),
        supported: t.widget.supported,
        hideErrors: t.widget.hideErrors,
        fields: t.widget.fields.map((f) => ({ key: f.key, label: f.label, format: f.format })),
      };
      if (t.widget.nowPlaying) out.widget.nowPlaying = true;
    }
    return out;
  };

  const group = (g: PublicGroup): PublicGroup => {
    const out: PublicGroup = { id: g.id, name: scrub(g.name), collapsed: g.collapsed, groups: g.groups.map(group), tiles: g.tiles.map(tile) };
    if (g.columns !== undefined) out.columns = g.columns;
    return out;
  };

  const problem = (p: Problem): Problem => {
    const out: Problem = { ...p, message: scrub(p.message) };
    if (p.excerpt) out.excerpt = { ...p.excerpt, lines: p.excerpt.lines.map(scrub) };
    return out;
  };

  const s = input.settings;
  const cfg: PublicConfig = {
    rev: input.rev,
    title: scrub(s.title),
    theme: input.theme,
    configPath: input.configPath,
    sampleInUse: input.sampleInUse,
    loadedAt: input.loadedAt,
    usingLastGood: input.usingLastGood,
    settings: {
      hideNoCheck: s.hideNoCheck,
      groupsInitiallyCollapsed: s.groupsInitiallyCollapsed,
      disableCollapse: s.disableCollapse,
      statusIntervalS: s.statusIntervalS,
      widgetIntervalS: s.widgetIntervalS,
    },
    groups: input.groups.map(group),
    problems: input.problems.map(problem),
  };
  if (input.error) cfg.error = problem(input.error);
  return cfg;
}
