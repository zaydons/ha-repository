// @ts-check
// One service tile (UX §4, §5, §6.1, §10, §14). The whole tile is a single
// <a target="_blank" rel="noopener noreferrer"> with no nested controls; a
// tile without an http(s) href is a plain, non-focusable box.
import { html } from "../lib.js";
import {
  lookup,
  nowPlayingView,
  problemLocation,
  statusView,
  stripTicks,
  tileLabel,
  widgetView,
} from "../model.js";
import { Glyph } from "./Glyph.js";
import { Icon } from "./Icon.js";
import { NowPlaying } from "./NowPlaying.js";
import { RichText } from "./RichText.js";
import { Stats } from "./Stats.js";
import { StatusPill } from "./StatusPill.js";

/** DOM id of a tile (header summary focuses it). @param {string} id */
export const tileDomId = (id) => `tile-${id}`;

/**
 * @param {{ tile: import("../model.js").Tile, snap: import("../model.js").Snapshot | null,
 *   ctx: import("../model.js").ViewCtx, problems: import("../model.js").Problem[] }} props
 */
export function Tile({ tile, snap, ctx, problems }) {
  const result = lookup(snap?.widgets, tile.id);
  const sv = statusView(tile, lookup(snap?.status, tile.id), ctx);
  const wv = widgetView(tile, result, ctx);
  const np = nowPlayingView(tile, result, wv, ctx.locale);
  const hasWidget = !!tile.widget;
  const note = !hasWidget && problems.length > 0 ? problems[0] : null;

  const descId = `d-${tile.id}`;
  const described = [
    sv.kind === "hidden" || sv.kind === "loading" ? "" : sv.tooltip.replace(/\n/g, ". "),
    wv.sr,
    np.sr,
    ...problems.map((p) => `Config problem: ${stripTicks(p.message)} (${problemLocation(p)})`),
  ]
    .filter(Boolean)
    .join(". ");

  const descText = sv.inline ?? tile.description ?? "";
  const classes = [
    "tile",
    tile.href ? "is-link" : "is-static",
    hasWidget ? "has-stats" : "",
    tile.widget?.nowPlaying ? "has-np" : "",
    sv.kind === "down" ? "is-down" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = html`
    <div class="tile-head">
      <${Icon} key=${tile.icon.kind === "img" ? tile.icon.src : "letter"} icon=${tile.icon} name=${tile.name} />
      <div class="tile-text">
        <span class="tile-name" title=${tile.name}>${tile.name}</span>
        <span class=${sv.inline ? "tile-desc is-reason" : "tile-desc"} title=${descText}>
          ${sv.inline ? html`<${Glyph} name="closeCircle" />` : null}${descText}
        </span>
      </div>
      <${StatusPill} view=${sv} />
    </div>
    ${hasWidget ? html`<${Stats} view=${wv} count=${tile.widget?.fields.length ?? 0} />` : null}
    ${note
      ? html`<div class="stats" data-n="1" aria-hidden="true">
          <p class="stats-msg is-error" title=${stripTicks(note.message)}>
            <${Glyph} name="alert" />
            <span class="stats-msg-text">This tile has a config problem: <${RichText} text=${note.message} /> (${problemLocation(note)})</span>
          </p>
        </div>`
      : null}
    <${NowPlaying} view=${np} />
    ${tile.href ? html`<${Glyph} name="openInNew" class="tile-open" />` : null}
    <span id=${descId} class="vh">${described}</span>
  `;

  const label = tileLabel(tile, sv);
  if (tile.href) {
    return html`<a id=${tileDomId(tile.id)} class=${classes} href=${tile.href} target="_blank"
      rel="noopener noreferrer" aria-label=${label} aria-describedby=${descId}>${body}</a>`;
  }
  return html`<div id=${tileDomId(tile.id)} class=${classes} role="group" tabindex="-1"
    aria-label=${label} aria-describedby=${descId}>${body}</div>`;
}
