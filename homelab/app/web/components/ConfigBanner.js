// @ts-check
// Config error banner while the last good config is shown (UX §8.2).
// role="alert" fires once when it appears; polling re-renders don't remount it.
import { html } from "../lib.js";
import { DOCS_LINKS, bannerTitle, clockTimeOf } from "../model.js";
import { Excerpt } from "./Excerpt.js";
import { Glyph } from "./Glyph.js";
import { RichText } from "./RichText.js";

/**
 * @param {{ error: import("../model.js").Problem, loadedAt: string, problemCount: number,
 *   problemsOpen: boolean, onToggleProblems: () => void, onDismiss: () => void, locale?: string }} p
 */
export function ConfigBanner(p) {
  const loaded = clockTimeOf(p.loadedAt, p.locale);
  return html`<div class="banner" role="alert">
    <${Glyph} name="alert" class="banner-glyph" />
    <div class="banner-body">
      <p class="banner-title" tabindex="-1">${bannerTitle(p.error)}</p>
      <p><${RichText} text=${p.error.message} /></p>
      <p>${loaded ? `Showing the last working config (loaded ${loaded}).` : "Showing the last working config."}</p>
      ${p.error.excerpt ? html`<${Excerpt} excerpt=${p.error.excerpt} />` : null}
      <p class="banner-actions">
        <button type="button" class="text-btn" aria-expanded=${p.problemsOpen ? "true" : "false"}
          aria-controls="hl-problems" onClick=${p.onToggleProblems}>
          ${p.problemsOpen ? "Hide problems" : `Show all problems (${p.problemCount})`}
        </button>
        <a class="ext-link" href=${DOCS_LINKS.configErrors.href} target="_blank" rel="noopener noreferrer">
          ${DOCS_LINKS.configErrors.text}<${Glyph} name="openInNew" /><span class="vh"> (opens in new tab)</span>
        </a>
      </p>
    </div>
    <button type="button" class="icon-btn banner-close" aria-label="Dismiss" title="Dismiss" onClick=${p.onDismiss}>
      <${Glyph} name="close" />
    </button>
  </div>`;
}
