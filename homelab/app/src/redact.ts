// Secret redaction for log lines, error details and anything else that leaves
// the process. Design §4.5 / §7.3. Fails safe: when in doubt, redact.

export const REDACTED = "••••";

/** Secrets shorter than this are ignored: they would mangle ordinary text and aren't real secrets. */
export const MIN_SECRET_LENGTH = 3;

/** Query parameters whose values are always redacted (case-insensitive). */
const SECRET_PARAMS = ["apikey", "api_key", "token", "x-plex-token", "key", "password", "pass", "access_token"];

const QUERY_PARAM_RE = new RegExp(`([?&;](?:${SECRET_PARAMS.map(escapeRegExp).join("|")})=)[^&#;\\s"'<>]*`, "gi");
// scheme://user:pass@host  ->  scheme://••••@host
const USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@"'<>]+@/gi;
// Authorization-style credentials that may end up in an error message.
const AUTH_HEADER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const MEDIABROWSER_RE = /(Token=")[^"]*(")/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every distinct form a secret may take in text: raw and URL-encoded variants. */
function secretForms(secret: string): string[] {
  const forms = new Set<string>([secret]);
  try {
    forms.add(encodeURIComponent(secret));
    forms.add(new URLSearchParams({ x: secret }).toString().slice(2)); // form encoding ("+" for space)
  } catch {
    // lone surrogates can't be encoded; the raw form is still redacted
  }
  return [...forms];
}

/**
 * Replace every occurrence of any known secret value, plus credential-looking
 * query parameters, URL userinfo and Authorization values, with REDACTED.
 */
export function redact(text: string, secrets: Iterable<string> = []): string {
  if (typeof text !== "string" || text.length === 0) return text;

  const forms: string[] = [];
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < MIN_SECRET_LENGTH) continue;
    for (const f of secretForms(s)) forms.push(f);
  }
  // Longest first so a secret that contains another is replaced whole.
  forms.sort((a, b) => b.length - a.length);

  let out = text;
  for (const f of forms) {
    if (out.includes(f)) out = out.split(f).join(REDACTED);
  }
  out = out.replace(QUERY_PARAM_RE, `$1${REDACTED}`);
  out = out.replace(USERINFO_RE, `$1${REDACTED}@`);
  out = out.replace(AUTH_HEADER_RE, `$1 ${REDACTED}`);
  out = out.replace(MEDIABROWSER_RE, `$1${REDACTED}$2`);
  return out;
}
