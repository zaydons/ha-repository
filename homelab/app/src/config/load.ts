// Config pipeline (design §4.8): parse → resolve secrets → validate/normalise.
// Pure: takes file texts, returns either a built config or a fatal error.
import type { IconService, NormalisedTile, Problem, PublicGroup, Settings } from "../types.ts";
import type { WidgetPlugin } from "../widgets/types.ts";
import { MIN_SECRET_LENGTH, redact } from "../redact.ts";
import { buildExcerpt, SECRET_KEY_RE } from "./excerpt.ts";
import type { Issue } from "./issues.ts";
import { parseYaml } from "./parse.ts";
import type { ParsedFile, PNode } from "./parse.ts";
import { readSecrets } from "./secrets.ts";
import { readSettings } from "./settings.ts";
import { validateServices } from "./validate.ts";

export const SERVICES_FILE = "services.yaml";
export const SETTINGS_FILE = "settings.yaml";
export const SECRETS_FILE = "secrets.yaml";
export const CA_FILE = "ca.pem";
export const CONFIG_FILES = [SERVICES_FILE, SETTINGS_FILE, SECRETS_FILE] as const;
/** Files whose changes trigger a reload: the config files plus ca.pem (read by the scheduler). */
export const WATCHED_FILES = [...CONFIG_FILES, CA_FILE] as const;

/** Homepage files a migrated folder may contain; each is listed once as info. */
export const IGNORED_FILES = [
  "bookmarks.yaml",
  "widgets.yaml",
  "docker.yaml",
  "kubernetes.yaml",
  "proxmox.yaml",
  "custom.css",
  "custom.js",
] as const;

export interface SourceTexts {
  /** null = file absent. */
  services: string | null;
  settings: string | null;
  secrets: string | null;
}

export interface BuildDeps {
  plugins: readonly WidgetPlugin[];
  icons: Pick<IconService, "resolve">;
  /** Ignored Homepage files present in the folder. */
  ignoredFiles?: readonly string[];
  /** Secrets known from elsewhere (the last good config): always redacted from problems. */
  knownSecrets?: readonly string[];
}

export interface BuiltConfig {
  ok: true;
  settings: Settings;
  groups: PublicGroup[];
  tiles: NormalisedTile[];
  problems: Problem[];
  /** Everything to redact from logs: secrets.yaml values and every secret-position value. */
  secrets: string[];
  /** Values at secret positions only; scrubbed from the public projection as a backstop. */
  hardSecrets: string[];
  counts: { groups: number; services: number; widgets: number };
}

export interface FatalConfig {
  ok: false;
  error: Problem;
  /** All fatal problems (error first). */
  problems: Problem[];
  /** Best-effort secrets known from the failed attempt (for log redaction). */
  secrets: string[];
}

export type BuildResult = BuiltConfig | FatalConfig;

function usable(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const v of values) if (typeof v === "string" && v.length >= MIN_SECRET_LENGTH) out.add(v);
  return [...out];
}

function allLines(p: ParsedFile | null): Set<number> {
  const s = new Set<number>();
  if (p) for (let i = 1; i <= p.lines.length; i++) s.add(i);
  return s;
}

/** Mark every line under a secret-looking key, and every `!secret` scalar, anywhere in the tree. */
function markSecretSubtrees(node: PNode | null, out: Set<number>, under = false): void {
  if (!node) return;
  const mark = (n: PNode) => {
    for (let l = n.line; l <= Math.max(n.line, n.endLine); l++) out.add(l);
  };
  if (node.kind === "scalar") {
    if (under || node.tag === "!secret") mark(node);
    return;
  }
  if (under) mark(node);
  if (node.kind === "seq") for (const it of node.items) markSecretSubtrees(it, out, under);
  else for (const e of node.entries) markSecretSubtrees(e.value, out, under || SECRET_KEY_RE.test(e.key));
}

/** Best-effort values from a secrets.yaml that may not parse: `name: value` lines. */
function looseSecretValues(p: ParsedFile | null): string[] {
  const out: string[] = [];
  if (!p) return out;
  for (const line of p.lines) {
    const m = /^\s*[^\s#:][^:#]*:\s+(.+?)\s*$/.exec(line);
    if (!m?.[1]) continue;
    const v = m[1].replace(/\s+#.*$/, "");
    out.push(v, v.replace(/^(["'])(.*)\1$/, "$2"), v.replace(/^["']/, ""));
  }
  return out;
}

function finish(
  issues: readonly Issue[],
  files: ReadonlyMap<string, { lines: string[]; sensitive: ReadonlySet<number> }>,
  secrets: readonly string[],
  mode: "parsed" | "fatal" = "parsed",
): Problem[] {
  return issues.map((i) => {
    const p: Problem = { severity: i.severity, file: i.file, code: i.code, message: redact(i.message, secrets) };
    if (i.line !== undefined) p.line = i.line;
    if (i.col !== undefined) p.col = i.col;
    if (i.tileId !== undefined) p.tileId = i.tileId;
    const f = files.get(i.file);
    if (f && i.severity !== "info") {
      const ex = buildExcerpt(f.lines, i.line, f.sensitive, secrets, mode);
      if (ex) p.excerpt = ex;
    }
    return p;
  });
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export function buildConfig(src: SourceTexts, deps: BuildDeps): BuildResult {
  const secretsFile = src.secrets === null ? null : parseYaml(SECRETS_FILE, src.secrets);
  const settingsFile = src.settings === null ? null : parseYaml(SETTINGS_FILE, src.settings);
  const servicesFile = src.services === null ? null : parseYaml(SERVICES_FILE, src.services);

  const fatal: Issue[] = [];
  for (const f of [servicesFile, settingsFile, secretsFile]) if (f) fatal.push(...f.errors);
  if (servicesFile === null) {
    fatal.push({ severity: "error", file: SERVICES_FILE, code: "file.missing", message: "services.yaml is missing. Create it in the app's config folder (or restart the app to get the sample back)." });
  } else if (servicesFile.errors.length === 0 && servicesFile.root && servicesFile.root.kind !== "seq") {
    fatal.push({ severity: "error", file: SERVICES_FILE, line: servicesFile.root.line, col: servicesFile.root.col, code: "config.root", message: 'services.yaml must be a list of groups: each group starts with "- Group name:".' });
  }
  if (settingsFile && settingsFile.errors.length === 0 && settingsFile.root && settingsFile.root.kind !== "map") {
    fatal.push({ severity: "error", file: SETTINGS_FILE, line: settingsFile.root.line, col: settingsFile.root.col, code: "config.root", message: "settings.yaml must be a map of settings (key: value)." });
  }
  if (secretsFile && secretsFile.errors.length === 0 && secretsFile.root && secretsFile.root.kind !== "map") {
    fatal.push({ severity: "error", file: SECRETS_FILE, line: secretsFile.root.line, col: secretsFile.root.col, code: "config.root", message: "secrets.yaml must be a map of names to values (name: value)." });
  }

  const sec = readSecrets(secretsFile && secretsFile.errors.length === 0 ? secretsFile.root : null);
  const secretsYamlValues = [...sec.secrets.values()];

  if (fatal.length > 0) {
    // Fail closed (review B1): fatal excerpts use the "fatal" mode, which masks
    // every value, and redact every secret we can know of.
    const secrets = usable([...secretsYamlValues, ...looseSecretValues(secretsFile), ...(deps.knownSecrets ?? [])]);
    const files = new Map<string, { lines: string[]; sensitive: ReadonlySet<number> }>();
    if (servicesFile) files.set(SERVICES_FILE, { lines: servicesFile.lines, sensitive: new Set() });
    if (settingsFile) files.set(SETTINGS_FILE, { lines: settingsFile.lines, sensitive: new Set() });
    // Every value in secrets.yaml is secret: mask all of its lines.
    if (secretsFile) files.set(SECRETS_FILE, { lines: secretsFile.lines, sensitive: allLines(secretsFile) });
    const problems = finish(fatal, files, secrets, "fatal");
    return { ok: false, error: problems[0]!, problems, secrets };
  }

  const st = readSettings(settingsFile?.root ?? null, sec.secrets);
  const sv = validateServices({
    root: servicesFile!.root,
    settings: st.settings,
    layout: st.layout,
    secrets: sec.secrets,
    plugins: deps.plugins,
    icons: deps.icons,
  });

  const issues: Issue[] = [];
  for (const f of [servicesFile, settingsFile, secretsFile]) if (f) issues.push(...f.warnings);
  for (const i of sec.issues) issues.push({ severity: "warning", file: SECRETS_FILE, line: i.line, col: i.col, code: "secret.invalid", message: i.message });
  issues.push(...st.issues, ...sv.issues);
  for (const name of deps.ignoredFiles ?? []) {
    issues.push({ severity: "info", file: name, code: "file.ignored", message: `Ignored ${name}: not supported in v1.` });
  }

  const hardSecrets = usable([...sv.hardSecrets, ...st.providerSecrets]);
  const secrets = usable([...secretsYamlValues, ...sv.hardSecrets, ...sv.softSecrets, ...st.providerSecrets]);
  const redactWith = usable([...secrets, ...(deps.knownSecrets ?? [])]);
  const svcSensitive = new Set(sv.sensitiveLines);
  markSecretSubtrees(servicesFile!.root, svcSensitive);
  const setSensitive = new Set(st.sensitiveLines);
  if (settingsFile) markSecretSubtrees(settingsFile.root, setSensitive);
  const files = new Map<string, { lines: string[]; sensitive: ReadonlySet<number> }>();
  files.set(SERVICES_FILE, { lines: servicesFile!.lines, sensitive: svcSensitive });
  if (settingsFile) files.set(SETTINGS_FILE, { lines: settingsFile.lines, sensitive: setSensitive });
  if (secretsFile) files.set(SECRETS_FILE, { lines: secretsFile.lines, sensitive: allLines(secretsFile) });

  const problems = finish(issues, files, redactWith);
  // Stable order: severity, then file, then line.
  problems.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

  return { ok: true, settings: st.settings, groups: sv.groups, tiles: sv.tiles, problems, secrets, hardSecrets, counts: sv.counts };
}
