// @ts-check
// YAML excerpt (UX §8.2): line numbers, error line marked with ▶ and bold.
// Lines arrive redacted from the server; rendered as text.
import { html } from "../lib.js";

/** @param {{ excerpt: import("../model.js").Excerpt }} props */
export function Excerpt({ excerpt }) {
  return html`<pre class="excerpt" aria-label="File excerpt">${excerpt.lines.map((line, i) => {
    const n = excerpt.startLine + i;
    const mark = n === excerpt.markLine;
    return html`<span class=${mark ? "ex-line is-mark" : "ex-line"} key=${n}><span class="ex-mark" aria-hidden="true">${mark ? "▶" : " "}</span><span class="ex-num">${n}</span><span class="ex-text">${line}</span>${"\n"}</span>`;
  })}</pre>`;
}
