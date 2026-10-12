// @ts-check
// Status pill (UX §5.1): icon shape + word, never colour alone.
import { html } from "../lib.js";
import { Glyph } from "./Glyph.js";

const GLYPH = /** @type {Record<string, string>} */ ({
  up: "checkCircle",
  down: "closeCircle",
  nocheck: "circleOutline",
  unknown: "helpCircle",
});

/** @param {{ view: import("../model.js").StatusView }} props */
export function StatusPill({ view }) {
  if (view.kind === "hidden") return html`<span class="pill-slot"></span>`;
  if (view.kind === "loading") {
    return html`<span class="pill-slot"><span class="pill pill-loading skeleton" title=${view.tooltip}></span></span>`;
  }
  return html`<span class="pill-slot">
    <span class=${`pill pill-${view.kind}${view.stale ? " is-stale" : ""}`} title=${view.tooltip}>
      <${Glyph} name=${GLYPH[view.kind] ?? "helpCircle"} />
      <span class="pill-word">${view.word}</span>
      ${view.stale ? html`<${Glyph} name="timerOutline" class="pill-stale" />` : null}
    </span>
  </span>`;
}
