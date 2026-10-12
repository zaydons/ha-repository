// Problem excerpts: ±1 line around the error with values redacted
// (design §4.8, UX §8.2). Fails safe: a line is masked if its key looks
// secret, if the validator marked it sensitive, or if it contains a known
// secret value (redact()).
import type { ProblemExcerpt } from "../types.ts";
import { redact } from "../redact.ts";

export const EXCERPT_MASK = "••••••";

/** Keys whose values are always masked in excerpts. */
export const SECRET_KEY_RE = /key|token|password|secret|apikey|pass|username|auth|cookie|credential/i;

const MAX_LINE = 200;

// "  - name: value", "name: value", "- value"
const KEY_VALUE_RE = /^(\s*(?:-\s+)*)((?:"[^"]*"|'[^']*'|[^\s:#][^:#]*?))(\s*:)(\s+|$)(.*)$/;
const SEQ_ITEM_RE = /^(\s*-\s+)(.+)$/;

/**
 * Redact one source line. `sensitive` = the validator saw a secret-bearing
 * value on this line (e.g. a `!secret` or a plugin secret key).
 */
export function redactLine(line: string, sensitive: boolean, secrets: readonly string[]): string {
  let out = line;
  const kv = KEY_VALUE_RE.exec(out);
  if (kv) {
    const [, indent = "", key = "", colon = "", space = "", value = ""] = kv;
    const bareKey = key.replace(/^["']|["']$/g, "");
    if (value.trim() !== "" && (sensitive || SECRET_KEY_RE.test(bareKey))) {
      out = `${indent}${key}${colon}${space || " "}${EXCERPT_MASK}`;
    }
  } else if (sensitive) {
    const seq = SEQ_ITEM_RE.exec(out);
    out = seq ? `${seq[1]}${EXCERPT_MASK}` : out.replace(/\S.*$/, EXCERPT_MASK);
  }
  out = redact(out, secrets);
  if (out.length > MAX_LINE) out = out.slice(0, MAX_LINE) + "…";
  return out;
}

export function buildExcerpt(
  lines: readonly string[],
  line: number | undefined,
  sensitiveLines: ReadonlySet<number>,
  secrets: readonly string[],
): ProblemExcerpt | undefined {
  if (line === undefined || line < 1 || lines.length === 0) return undefined;
  const mark = Math.min(line, lines.length);
  const start = Math.max(1, mark - 1);
  const end = Math.min(lines.length, mark + 1);
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(redactLine(lines[n - 1] ?? "", sensitiveLines.has(n), secrets));
  return { startLine: start, lines: out, markLine: mark };
}
