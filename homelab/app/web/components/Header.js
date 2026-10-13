// @ts-check
// Page header (UX §3.3): title, health summary, last update, refresh, config chip,
// and the single polite live region for health changes (UX §10).
import { html } from "../lib.js";
import { absoluteTime, relativeTime } from "../format.js";
import { Glyph } from "./Glyph.js";

/**
 * @typedef {object} HeaderProps
 * @property {string} title
 * @property {{ tone: "ok" | "down" | "warn", text: string } | null} summary
 * @property {() => void} onSummary
 * @property {number} lastPollAt
 * @property {number} now
 * @property {boolean} stale
 * @property {boolean} refreshBusy
 * @property {() => void} onRefresh
 * @property {{ text: string, onClick: () => void, expanded?: boolean, controls?: string } | null} chip
 * @property {string} announcement
 * @property {string} [locale]
 */

/** Compact chip text at xs (UX L4): the count, or "Config" for the error chip. @param {string} text */
function chipShort(text) {
  const m = /^(\d+)\b/.exec(text);
  return m ? m[1] : "Config";
}

const SUMMARY_GLYPH = { ok: "checkCircle", down: "closeCircle", warn: "alert" };

/** @param {HeaderProps} p */
export function Header(p) {
  const rel = p.lastPollAt ? relativeTime(p.now - p.lastPollAt, p.locale) : "";
  // At xs the leading word is hidden visually (UX §3.4 phone header: "1 down · 8s ago").
  // Never polled successfully: say so instead of showing skeletons forever (UX delta 8, D5/L2).
  const updated = rel
    ? html`<span class="updated-word">${p.stale ? "Stale: updated " : "Updated "}</span>${rel}`
    : p.stale
      ? "Can't reach the dashboard backend. Retrying."
      : null;
  const updatedTitle = p.stale
    ? "Can't reach the dashboard backend. Retrying."
    : p.lastPollAt
      ? absoluteTime(p.lastPollAt, p.locale)
      : "";
  return html`<header class="hdr">
    <h1 class="hdr-title">${p.title}</h1>
    <div class="hdr-bar">
      ${p.summary
        ? p.summary.tone === "ok"
          ? html`<span class="sum sum-ok"><${Glyph} name=${SUMMARY_GLYPH.ok} /><span>${p.summary.text}</span></span>`
          : html`<button type="button" class=${`sum sum-${p.summary.tone}`} onClick=${p.onSummary}
              title="Go to the first problem">
              <${Glyph} name=${SUMMARY_GLYPH[p.summary.tone]} /><span>${p.summary.text}</span>
            </button>`
        : null}
      <span class=${p.stale ? "updated is-stale" : "updated"} title=${updatedTitle}>${updated}</span>
      <button type="button" class=${p.refreshBusy ? "icon-btn refresh is-busy" : "icon-btn refresh"}
        aria-label=${p.refreshBusy ? "Refreshing…" : "Refresh now"} title=${p.refreshBusy ? "Refreshing…" : "Refresh now"}
        aria-disabled=${p.refreshBusy ? "true" : "false"} onClick=${() => {
          // aria-disabled, not disabled: a disabled button would drop keyboard focus (review F4).
          if (!p.refreshBusy) p.onRefresh();
        }}>
        <${Glyph} name="refresh" class="refresh-glyph" />
        <span class="refresh-label" aria-hidden="true">Refreshing…</span>
      </button>
      ${p.chip
        ? html`<button type="button" class="chip" onClick=${p.chip.onClick} aria-label=${p.chip.text}
            aria-expanded=${p.chip.expanded === undefined ? undefined : String(p.chip.expanded)}
            aria-controls=${p.chip.controls}>
            <${Glyph} name="alert" /><span class="chip-long">${p.chip.text}</span><span class="chip-short" aria-hidden="true">${chipShort(p.chip.text)}</span>
          </button>`
        : null}
    </div>
    <div class="vh" role="status" aria-live="polite" aria-atomic="true">${p.announcement}</div>
  </header>`;
}
