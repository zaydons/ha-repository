// @ts-check
// Tile icon (UX §4.1, design §6). Icons only ever load through <img src>
// (threat model R3); a failed load reveals the letter fallback. The icon is
// decorative: the tile name carries the label.
import { html } from "../lib.js";

/** @param {Event} e */
function onError(e) {
  const img = /** @type {HTMLImageElement} */ (e.currentTarget);
  img.hidden = true;
  img.parentElement?.classList.add("icon-failed");
}

/** @param {{ icon: import("../model.js").Icon, name: string }} props */
export function Icon({ icon, name }) {
  const letter = icon.kind === "letter" ? icon.letter : (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();
  if (icon.kind === "letter") {
    return html`<span class="icon icon-letter" aria-hidden="true"><span class="icon-letter-ch">${letter}</span></span>`;
  }
  return html`<span class="icon" aria-hidden="true">
    <span class="icon-letter-ch icon-fallback">${letter}</span>
    <img class=${icon.mono ? "icon-img icon-mono" : "icon-img"} src=${icon.src} alt="" loading="lazy"
      decoding="async" referrerpolicy="no-referrer" draggable="false" onError=${onError} />
  </span>`;
}
