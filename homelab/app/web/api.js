// @ts-check
// API client (design §4.4). Every URL is relative to the page, so it works
// under HA's per-install ingress prefix. Never a leading slash.

import { sanitizeConfig, sanitizeState } from "./model.js";

/** The refresh button is never disabled longer than this (UX §3.3, review F10). */
export const MAX_RETRY_AFTER_S = 10;

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * @param {string} path relative path, e.g. "api/state?rev=3"
 * @param {RequestInit} [init]
 * @param {typeof fetch} [fetchImpl]
 */
async function request(path, init = {}, fetchImpl = fetch) {
  if (path.startsWith("/")) throw new Error("API paths must be relative");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(path, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      ...init,
      signal: ctl.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "Request timed out" : "Network error";
    throw new ApiError(msg);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {typeof fetch} [fetchImpl] */
export async function getConfig(fetchImpl) {
  const r = await request("api/config", {}, fetchImpl);
  if (!r.ok) throw new ApiError(`api/config returned HTTP ${r.status}`, r.status);
  return sanitizeConfig(r.body);
}

/** @param {number | null} rev @param {typeof fetch} [fetchImpl] */
export async function getState(rev, fetchImpl) {
  const q = typeof rev === "number" && Number.isInteger(rev) && rev >= 0 ? `?rev=${rev}` : "";
  const r = await request(`api/state${q}`, {}, fetchImpl);
  if (!r.ok) throw new ApiError(`api/state returned HTTP ${r.status}`, r.status);
  return sanitizeState(r.body);
}

/**
 * Ask the server to re-check everything now.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ accepted: true } | { accepted: false, retryAfterS: number }>}
 */
export async function postRefresh(fetchImpl) {
  const r = await request(
    "api/refresh",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    fetchImpl,
  );
  if (r.status === 202) return { accepted: true };
  if (r.status === 429) {
    const s = r.body && typeof r.body === "object" ? Number(/** @type {any} */ (r.body).retryAfterS) : NaN;
    return { accepted: false, retryAfterS: Number.isFinite(s) && s > 0 ? Math.min(MAX_RETRY_AFTER_S, Math.ceil(s)) : 10 };
  }
  throw new ApiError(`api/refresh returned HTTP ${r.status}`, r.status);
}
