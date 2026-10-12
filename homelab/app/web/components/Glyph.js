// @ts-check
// UI glyph from the bundled MDI path constants (icons.js). Decorative only.
import { html } from "../lib.js";
import { MDI } from "../icons.js";

/** @param {{ name: string, class?: string }} props */
export function Glyph({ name, class: cls = "" }) {
  const d = MDI[name];
  if (!d) return null;
  return html`<svg class=${`glyph ${cls}`.trim()} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d=${d} /></svg>`;
}
