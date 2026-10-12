// Secret resolution (design §4.8): `!secret name` and `{{HOMEPAGE_VAR_X}}`
// look up secrets.yaml. `{{HOMEPAGE_FILE_X}}` is not supported.
import type { PNode, PScalar } from "./parse.ts";
import { scalarText } from "./parse.ts";

export type SecretMap = ReadonlyMap<string, string>;

export interface SecretsResult {
  secrets: Map<string, string>;
  /** Item-level problems in secrets.yaml (non-scalar values). */
  issues: { line: number; col: number; message: string }[];
}

/** secrets.yaml root → name/value map. The root must be a map (checked by the caller). */
export function readSecrets(root: PNode | null): SecretsResult {
  const secrets = new Map<string, string>();
  const issues: SecretsResult["issues"] = [];
  if (!root || root.kind !== "map") return { secrets, issues };
  for (const e of root.entries) {
    if (e.value.kind !== "scalar") {
      issues.push({ line: e.keyLine, col: e.keyCol, message: `Secret "${e.key}" must be a single value, not a list or block.` });
      continue;
    }
    const v = scalarText(e.value);
    if (v !== null) secrets.set(e.key, v);
  }
  return { secrets, issues };
}

export type Resolved = { ok: true; value: string | number | boolean | null; fromSecret: boolean } | { ok: false; code: string; message: string };

const PLACEHOLDER_RE = /\{\{\s*(HOMEPAGE_(VAR|FILE)_([A-Za-z0-9_]+))\s*\}\}/g;

/**
 * Resolve a scalar. Strings get `{{HOMEPAGE_VAR_*}}` substitution; `!secret`
 * scalars are replaced whole. fromSecret = the value came (partly) from secrets.yaml.
 */
export function resolveScalar(n: PScalar, secrets: SecretMap): Resolved {
  if (n.tag === "!secret") {
    const name = scalarText(n)?.trim() ?? "";
    if (!name) return { ok: false, code: "secret.missing", message: "`!secret` needs a name, e.g. `!secret plex_key`." };
    const v = secrets.get(name);
    if (v === undefined) return { ok: false, code: "secret.missing", message: `Secret "${name}" isn't in secrets.yaml.` };
    return { ok: true, value: v, fromSecret: true };
  }
  if (typeof n.value !== "string") return { ok: true, value: n.value, fromSecret: false };
  const text = n.value;
  if (!text.includes("{{")) return { ok: true, value: text, fromSecret: false };
  let failure: Resolved | null = null;
  let used = false;
  const out = text.replace(PLACEHOLDER_RE, (whole, full: string, kind: string, short: string) => {
    if (failure) return whole;
    if (kind === "FILE") {
      failure = { ok: false, code: "secret.unsupported", message: `{{${full}}} isn't supported. Put the value in secrets.yaml and use {{HOMEPAGE_VAR_${short}}} or !secret.` };
      return whole;
    }
    const v = secrets.get(full) ?? secrets.get(short);
    if (v === undefined) {
      failure = { ok: false, code: "secret.missing", message: `Secret "${full}" (or "${short}") isn't in secrets.yaml.` };
      return whole;
    }
    used = true;
    return v;
  });
  if (failure) return failure;
  return { ok: true, value: out, fromSecret: used };
}
