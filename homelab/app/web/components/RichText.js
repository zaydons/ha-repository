// @ts-check
// Renders "text `code` text" with <code> spans. Every part is a text node.
import { html } from "../lib.js";
import { codeSegments } from "../model.js";

/** @param {{ text: string }} props */
export function RichText({ text }) {
  return codeSegments(text).map((s) => (s.code ? html`<code>${s.text}</code>` : s.text));
}
