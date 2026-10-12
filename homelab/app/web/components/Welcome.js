// @ts-check
// First-run welcome card (UX §9), shown while the sample config is in use.
import { html } from "../lib.js";
import { DOCS_LINKS } from "../model.js";
import { Glyph } from "./Glyph.js";

/** @param {{ title: string, configPath: string, onDismiss: () => void }} p */
export function Welcome(p) {
  const folder = p.configPath || "the app's config folder";
  return html`<section class="card welcome" aria-labelledby="hl-welcome-h">
    <${Glyph} name="handWave" class="welcome-glyph" />
    <div class="welcome-body">
      <h2 id="hl-welcome-h" class="card-title">Welcome to ${p.title}</h2>
      <p>This is a sample dashboard. Edit services.yaml to add your own services. It's in <code>${folder}</code> (open it
        with File editor or Studio Code Server). Changes show up here when you save.</p>
      <p>Coming from Homepage? Copy your services.yaml into that folder. Supported widgets work right away; others become plain links.</p>
      <p class="card-actions">
        <${ExtLink} link=${DOCS_LINKS.setup} />
        <${ExtLink} link=${DOCS_LINKS.widgets} />
      </p>
    </div>
    <button type="button" class="icon-btn banner-close" aria-label="Dismiss welcome" title="Dismiss" onClick=${p.onDismiss}>
      <${Glyph} name="close" />
    </button>
  </section>`;
}

/** @param {{ link: { href: string, text: string } }} p */
export function ExtLink({ link }) {
  return html`<a class="ext-link" href=${link.href} target="_blank" rel="noopener noreferrer">
    ${link.text}<${Glyph} name="openInNew" /><span class="vh"> (opens in new tab)</span>
  </a>`;
}
