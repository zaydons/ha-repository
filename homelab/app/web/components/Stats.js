// @ts-check
// Stats area (UX §4.1, §4.3, §5.3). Its box has a fixed height from config,
// so loading, values, errors and stale values never move the grid.
import { html } from "../lib.js";
import { stripTicks } from "../model.js";
import { Glyph } from "./Glyph.js";
import { RichText } from "./RichText.js";

/** @param {{ view: import("../model.js").WidgetView, count: number }} props */
export function Stats({ view, count }) {
  const n = Math.max(1, Math.min(4, count));
  if (view.kind === "unsupported" || view.kind === "error" || view.kind === "muted") {
    const cls = view.kind === "error" ? "stats-msg is-error" : "stats-msg is-muted";
    const glyph = view.kind === "error" ? "alert" : view.kind === "unsupported" ? "informationOutline" : null;
    const title = view.detail ? `${stripTicks(view.message)} (${view.detail})` : stripTicks(view.message);
    return html`<div class="stats" data-n=${n} aria-hidden="true">
      <p class=${cls} title=${title}>
        ${glyph ? html`<${Glyph} name=${glyph} />` : null}
        <span class="stats-msg-text"><${RichText} text=${view.message} /></span>
      </p>
    </div>`;
  }
  const loading = view.kind === "loading";
  return html`<div class=${`stats${view.kind === "stale" ? " is-stale" : ""}`} data-n=${n} aria-hidden="true">
    ${view.cells.map(
      (c) => html`<div class="stat">
        <span class="stat-label" title=${c.label}>${c.label}</span>
        ${loading
          ? html`<span class="stat-value"><span class="skeleton skeleton-value"></span></span>`
          : html`<span class=${c.missing ? "stat-value is-missing" : "stat-value"} title=${c.title || c.value}>${c.value}</span>`}
      </div>`,
    )}
    ${view.kind === "stale"
      ? html`<span class="stale-badge" title=${view.staleTitle}><${Glyph} name="timerOutline" />${view.staleText}</span>`
      : null}
  </div>`;
}
