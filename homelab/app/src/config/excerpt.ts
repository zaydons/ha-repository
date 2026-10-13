// Problem excerpts: ±1 line around the error with values redacted
// (design §4.8, UX §8.2, threat model R6). Two modes:
// - "parsed" (the file parsed; warnings): a line keeps its value unless the
//   validator marked it sensitive or a secret-looking key appears anywhere on
//   it (flow maps and JSON included). Known secret values are always redacted.
// - "fatal" (the file didn't parse, so nothing is known about it): fail closed.
//   Only the indentation, "- " markers and a plain key name survive; every
//   value and comment is masked, and so is every line inside a block scalar,
//   a multi-line quoted string, or the indented value of an empty `key:`.
import type { ProblemExcerpt } from "../types.ts";
import { redact } from "../redact.ts";

export const EXCERPT_MASK = "••••••";

/** Keys whose values are always masked in excerpts. */
export const SECRET_KEY_RE = /key|token|password|secret|apikey|pass|username|auth|cookie|credential/i;

const MAX_LINE = 200;
const SECRET_WORDS = "key|token|password|secret|apikey|pass|username|auth|cookie|credential";

// "  - name: value", "name: value"
const KEY_VALUE_RE = /^(\s*(?:-\s+)*)((?:"[^"]*"|'[^']*'|[^\s:#][^:#]*?))(\s*:)(\s+|$)(.*)$/;
const SEQ_ITEM_RE = /^(\s*-\s+)(.+)$/;
// Any `key: value` pair inside a line (flow maps, JSON style), quoted or not.
const INLINE_SECRET_PAIR_RE = new RegExp(
  `((?:"[^"]*(?:${SECRET_WORDS})[^"]*"|'[^']*(?:${SECRET_WORDS})[^']*'|[A-Za-z0-9_.-]*(?:${SECRET_WORDS})[A-Za-z0-9_.-]*)\\s*:)(\\s*)("(?:[^"\\\\]|\\\\.)*"?|'(?:[^']|'')*'?|[^,}\\]\\s#][^,}\\]#]*)`,
  "gi",
);
// Fatal mode: a short plain or quoted key; nothing else on the line is trusted.
const FATAL_KEY_RE = /^([ \t]*(?:-[ \t]+)*)("[A-Za-z0-9_ .-]{1,60}"|'[A-Za-z0-9_ .-]{1,60}'|[A-Za-z0-9_][A-Za-z0-9_ .-]{0,59}?)([ \t]*:)(?=[ \t]|$)/;
const BLOCK_HEADER_RE = /:[ \t]*[|>][0-9+-]*[ \t]*(#.*)?$|^[ \t]*(?:-[ \t]+)*[|>][0-9+-]*[ \t]*(#.*)?$/;

function clip(s: string): string {
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE) + "…" : s;
}

function maskInlinePairs(line: string): string {
  return line.replace(INLINE_SECRET_PAIR_RE, (_m, key: string, space: string) => `${key}${space || " "}${EXCERPT_MASK}`);
}

/**
 * Redact one source line of a file that parsed. `sensitive` = the validator
 * saw a secret-bearing value on this line.
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
  out = maskInlinePairs(out);
  return clip(redact(out, secrets));
}

/** Fail-closed rendering of one line of a file that didn't parse. */
export function redactFatalLine(line: string, insideValue: boolean, secrets: readonly string[]): string {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  const rest = line.slice(indent.length);
  if (rest === "") return line;
  if (insideValue) return clip(`${indent}${EXCERPT_MASK}`);
  if (rest.startsWith("#")) return clip(`${indent}# ${EXCERPT_MASK}`);
  if (/^(---|\.\.\.)[ \t]*$/.test(rest)) return line;
  const kv = FATAL_KEY_RE.exec(line);
  if (kv) {
    const [whole, lead = "", key = "", colon = ""] = kv;
    const after = line.slice(whole.length).trim();
    const shown = after === "" ? `${lead}${key}${colon}` : `${lead}${key}${colon} ${EXCERPT_MASK}`;
    return clip(redact(shown, secrets));
  }
  const dash = /^([ \t]*(?:-[ \t]+)+)/.exec(line);
  if (dash) return clip(`${dash[1]}${EXCERPT_MASK}`);
  return clip(`${indent}${EXCERPT_MASK}`);
}

/**
 * For a file that didn't parse: which lines (1-based) are inside a multi-line
 * value (block scalar body, open quoted string, or the indented continuation
 * of a key with an empty value)? Conservative: when unsure, it's a value.
 */
export function valueLines(lines: readonly string[]): Set<number> {
  const inside = new Set<number>();
  let blockIndent = -1;
  let openQuote: '"' | "'" | null = null;
  let emptyKeyIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i] ?? "";
    const indent = (/^[ \t]*/.exec(line)?.[0] ?? "").length;
    const blank = line.trim() === "";
    if (openQuote) {
      inside.add(n);
      if (closesQuote(line, openQuote)) openQuote = null;
      continue;
    }
    if (blockIndent >= 0) {
      if (blank || indent > blockIndent) {
        inside.add(n);
        continue;
      }
      blockIndent = -1;
    }
    if (emptyKeyIndent >= 0 && !blank) {
      // `key:` then a deeper line that isn't itself `key:` or `- item`: a plain multi-line value.
      if (indent > emptyKeyIndent && !FATAL_KEY_RE.test(line) && !/^[ \t]*-[ \t]/.test(line)) {
        inside.add(n);
        continue;
      }
      emptyKeyIndent = -1;
    }
    if (BLOCK_HEADER_RE.test(line)) {
      blockIndent = indent;
      continue;
    }
    const q = unclosedQuote(line);
    if (q) {
      openQuote = q;
      continue;
    }
    const kv = FATAL_KEY_RE.exec(line);
    if (kv && line.slice(kv[0].length).replace(/#.*$/, "").trim() === "") emptyKeyIndent = indent;
  }
  return inside;
}

/** The quote left open at the end of the line, if any (ignores comments). */
function unclosedQuote(line: string): '"' | "'" | null {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === '"') {
      if (c === "\\") i++;
      else if (c === '"') q = null;
    } else if (q === "'") {
      if (c === "'" && line[i + 1] === "'") i++;
      else if (c === "'") q = null;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) break;
    else if (c === '"' || c === "'") {
      // A quote opens a scalar only at a value position, not inside a plain word.
      const prev = line.slice(0, i).trimEnd();
      if (prev === "" || /[:,[{-]$/.test(prev)) q = c;
    }
  }
  return q;
}

function closesQuote(line: string, q: '"' | "'"): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === '"' && c === "\\") i++;
    else if (q === "'" && c === "'" && line[i + 1] === "'") i++;
    else if (c === q) return true;
  }
  return false;
}

export function buildExcerpt(
  lines: readonly string[],
  line: number | undefined,
  sensitiveLines: ReadonlySet<number>,
  secrets: readonly string[],
  mode: "parsed" | "fatal" = "parsed",
): ProblemExcerpt | undefined {
  if (line === undefined || line < 1 || lines.length === 0) return undefined;
  const mark = Math.min(line, lines.length);
  const start = Math.max(1, mark - 1);
  const end = Math.min(lines.length, mark + 1);
  const values = mode === "fatal" ? valueLines(lines.slice(0, end)) : new Set<number>();
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = lines[n - 1] ?? "";
    out.push(
      mode === "fatal"
        ? redactFatalLine(text, values.has(n) || sensitiveLines.has(n), secrets)
        : redactLine(text, sensitiveLines.has(n), secrets),
    );
  }
  return { startLine: start, lines: out, markLine: mark };
}
