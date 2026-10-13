// One-shot fetch of an icon from a fixed CDN URL (built by resolve.ts#cdnUrl).
// No redirects, 10 s timeout, 1 MB cap, image/* only, bytes must match the type.
import { contentTypeFor } from "./resolve.ts";
import { matchesType } from "./svg.ts";

export const MAX_ICON_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type CdnResult =
  | { ok: true; body: Buffer; contentType: string }
  /** notFound: the CDN said 404 (long negative cache); otherwise a transient failure. */
  | { ok: false; notFound: boolean; reason: string };

export async function fetchIcon(fetchFn: FetchFn, url: string, file: string): Promise<CdnResult> {
  const want = contentTypeFor(file);
  if (!want) return { ok: false, notFound: true, reason: "unsupported extension" };
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "image/*", "User-Agent": "HomelabDashboard (Home Assistant app)" },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, notFound: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error" };
  }
  try {
    if (res.status === 404) return { ok: false, notFound: true, reason: "HTTP 404" };
    if (res.status !== 200) return { ok: false, notFound: false, reason: `HTTP ${res.status}` };
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ct.startsWith("image/")) return { ok: false, notFound: false, reason: "not an image" };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_ICON_BYTES) return { ok: false, notFound: false, reason: "too large" };
    const body = await readCapped(res, MAX_ICON_BYTES);
    if (!body) return { ok: false, notFound: false, reason: "too large" };
    // A file that is not what it claims (or an unsafe SVG) won't change soon: cache it as a miss for long.
    if (!matchesType(body, want)) return { ok: false, notFound: true, reason: "content rejected" };
    return { ok: true, body, contentType: want };
  } catch {
    return { ok: false, notFound: false, reason: "network error" };
  } finally {
    // Release the connection if we stopped reading early.
    res.body?.cancel().catch(() => {});
  }
}

async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
