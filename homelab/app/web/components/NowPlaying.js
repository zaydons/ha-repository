// @ts-check
// Jellyfin "Now playing" list (UX §14). Fixed height: two row slots are
// always rendered. No interactive elements; rows are keyed by index so text
// changes in place. All strings are text nodes (the stub's <b>…</b> probe
// must show literally).
import { html } from "../lib.js";
import { NOW_PLAYING_ROWS, stripTicks } from "../model.js";
import { RichText } from "./RichText.js";
import { Glyph } from "./Glyph.js";

/** @param {{ row: import("../model.js").NowRow }} props */
function Row({ row }) {
  return html`<div class=${row.paused ? "np-row is-paused" : "np-row"}>
    <div class="np-line1">
      <${Glyph} name=${row.paused ? "pause" : "play"} />
      <span class="np-title" title=${row.title}>${row.title}</span>
      <span class="np-meta">
        <span class="np-meta-full">${row.meta}</span>
        <span class="np-meta-short">${row.metaShort}</span>
      </span>
    </div>
    <div class="np-line2" title=${row.line2}>${row.line2}</div>
    <div class="np-bar">
      ${row.pct === null
        ? null
        : html`<span class="np-track"><span class="np-fill" style=${{ width: `${row.pct}%` }}></span></span>`}
    </div>
  </div>`;
}

/** @param {{ view: import("../model.js").NowPlayingView }} props */
export function NowPlaying({ view }) {
  if (view.kind === "none") return null;
  /** @type {any[]} */
  const slots = [];
  for (let i = 0; i < NOW_PLAYING_ROWS; i++) {
    let content = null;
    if (view.kind === "loading") {
      content = html`<div class="np-row np-skel">
        <div class="np-line1"><span class="skeleton np-skel-glyph"></span><span class="skeleton np-skel-title"></span></div>
        <div class="np-line2"><span class="skeleton np-skel-sub"></span></div>
      </div>`;
    } else if (i === 0 && view.kind === "error") {
      content = view.message
        ? html`<div class="np-row np-note is-error"><div class="np-line1" title=${stripTicks(view.message)}>
            <${Glyph} name="alert" /><span class="np-note-text"><${RichText} text=${view.message} /></span>
          </div></div>`
        : html`<div class="np-row np-note"><div class="np-line1">
            <span class="np-dash">—</span>${view.muted ? null : html`<span class="np-note-text">Not available</span>`}
          </div></div>`;
    } else if (i === 0 && view.empty) {
      content = html`<div class="np-row np-note"><div class="np-line1">
        <${Glyph} name="playCircleOutline" /><span class="np-note-text">Nothing playing</span>
      </div></div>`;
    } else {
      const row = view.rows[i];
      if (row) content = html`<${Row} row=${row} />`;
    }
    slots.push(html`<div class="np-slot" key=${i}>${content}</div>`);
  }
  return html`<div class=${view.stale ? "np is-stale" : "np"} aria-hidden="true">
    <div class="np-head">
      <span class="np-label">Now playing</span>
      ${view.overflow ? html`<span class="np-more" title=${view.overflowTitle}>${view.overflow}</span>` : null}
    </div>
    ${slots}
  </div>`;
}
