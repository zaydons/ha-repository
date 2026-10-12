// @ts-check
// Whole-page states: fatal config error with no last good config (UX §8.3),
// no services (UX §9), and backend unreachable before the first load.
import { html } from "../lib.js";
import { DOCS_LINKS, problemLocation } from "../model.js";
import { Excerpt } from "./Excerpt.js";
import { Glyph } from "./Glyph.js";
import { RichText } from "./RichText.js";
import { ExtLink } from "./Welcome.js";

/** @param {{ error: import("../model.js").Problem | undefined, configPath: string }} p */
export function FatalError({ error, configPath }) {
  const folder = configPath || "the app's config folder";
  return html`<section class="page-state" aria-labelledby="hl-fatal-h">
    <${Glyph} name="alert" class="page-glyph is-warn" />
    <h2 id="hl-fatal-h" class="page-title">Your dashboard config has an error</h2>
    ${error
      ? html`<p>${problemLocation(error).replace(" line ", ", line ")}: <${RichText} text=${error.message} /></p>`
      : null}
    ${error?.excerpt ? html`<${Excerpt} excerpt=${error.excerpt} />` : null}
    <p>Fix the file in File editor or Studio Code Server (folder: <code>${folder}</code>). This page updates automatically when you save.</p>
    <p><${ExtLink} link=${DOCS_LINKS.configErrors} /></p>
  </section>`;
}

/** @param {{ configPath: string }} p */
export function Empty({ configPath }) {
  const folder = configPath || "the app's config folder";
  return html`<section class="page-state">
    <p>No services yet. Add one to services.yaml in <code>${folder}</code>.</p>
    <p><${ExtLink} link=${DOCS_LINKS.setup} /></p>
  </section>`;
}

/** @param {{ message: string }} p */
export function Unreachable({ message }) {
  return html`<section class="page-state" role="alert">
    <${Glyph} name="alert" class="page-glyph is-warn" />
    <p>Can't reach the dashboard backend. Retrying.</p>
    <p class="muted">${message}</p>
  </section>`;
}

export function Booting() {
  return html`<p class="boot" role="status">Loading…</p>`;
}

/** @param {{ text: string, action: { label: string, onClick: () => void } | null, onClose: () => void }} p */
export function Toast({ text, action, onClose }) {
  return html`<div class="toast">
    <span>${text}</span>
    ${action ? html`<button type="button" class="text-btn" onClick=${action.onClick}>${action.label}</button>` : null}
    <button type="button" class="icon-btn" aria-label="Close" onClick=${onClose}><${Glyph} name="close" /></button>
  </div>`;
}
