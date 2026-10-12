// @ts-check
// "Show all problems" list (UX §8.2): inline, not a modal. Escape closes it.
import { html } from "../lib.js";
import { problemLocation } from "../model.js";
import { Glyph } from "./Glyph.js";
import { RichText } from "./RichText.js";

const GLYPH = { error: "alertCircle", warning: "alert", info: "informationOutline" };
const WORD = { error: "Error", warning: "Warning", info: "Note" };

/** @param {{ problems: import("../model.js").Problem[], onClose: () => void }} props */
export function Problems({ problems, onClose }) {
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };
  return html`<section id="hl-problems" class="problems" aria-label="Config problems" tabindex="-1" onKeyDown=${onKey}>
    <ul class="problems-list">
      ${problems.map(
        (p, i) => html`<li key=${i} class=${`problem sev-${p.severity}`}>
          <${Glyph} name=${GLYPH[p.severity]} />
          <span class="vh">${WORD[p.severity]}: </span>
          <span class="problem-loc">${problemLocation(p)}</span>
          <span class="problem-msg"><${RichText} text=${p.message} /></span>
        </li>`,
      )}
    </ul>
    <button type="button" class="text-btn" onClick=${onClose}>Hide problems</button>
  </section>`;
}
