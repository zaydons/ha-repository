// @ts-check
// Group of tiles (UX §3.2, §10): collapsible heading button with a health
// summary that stays visible when collapsed; one nested level as H3.
import { html } from "../lib.js";
import { groupSummary, tileProblems } from "../model.js";
import { Glyph } from "./Glyph.js";
import { Tile } from "./Tile.js";

/**
 * @typedef {object} GroupProps
 * @property {import("../model.js").Group} group
 * @property {import("../model.js").Config} config
 * @property {import("../model.js").Snapshot | null} snap
 * @property {import("../model.js").ViewCtx} ctx
 * @property {(id: string) => boolean} isCollapsed
 * @property {(id: string) => void} onToggle
 * @property {Set<string>} downIds
 * @property {Set<string>} upIds
 * @property {number} [level]
 */

/** @param {GroupProps} props */
export function Group(props) {
  const { group, config, snap, ctx, isCollapsed, onToggle, downIds, upIds, level = 2 } = props;
  const collapsible = !config.settings.disableCollapse;
  const collapsed = collapsible && isCollapsed(group.id);
  const sum = groupSummary(group, downIds, upIds);
  const bodyId = `g-${group.id}`;
  const Heading = level === 2 ? "h2" : "h3";
  const headInner = html`
    ${collapsible ? html`<${Glyph} name="chevronDown" class="group-chevron" />` : null}
    <span class="group-name">${group.name}</span>
    <span class=${sum.down ? "group-sum is-down" : "group-sum"} aria-hidden="true">${sum.visible}</span>
    <span class="vh">${sum.spoken.slice(group.name.length)}</span>`;
  const gridStyle = group.columns ? { "--hl-cols": String(group.columns) } : undefined;

  return html`<section class=${`group level-${level}${collapsed ? " is-collapsed" : ""}`}>
    <${Heading} class="group-h">
      ${collapsible
        ? html`<button type="button" class="group-toggle" aria-expanded=${collapsed ? "false" : "true"}
            aria-controls=${bodyId} onClick=${() => onToggle(group.id)}>${headInner}</button>`
        : html`<span class="group-toggle is-static">${headInner}</span>`}
    </${Heading}>
    <div id=${bodyId} class="group-body" hidden=${collapsed}>
      ${group.tiles.length
        ? html`<div class=${group.columns ? "grid has-cols" : "grid"} style=${gridStyle}>
            ${group.tiles.map(
              (t) => html`<${Tile} key=${t.id} tile=${t} snap=${snap} ctx=${ctx} problems=${tileProblems(config, t.id)} />`,
            )}
          </div>`
        : null}
      ${group.groups.map((g) => html`<${Group} key=${g.id} ...${props} group=${g} level=${3} />`)}
    </div>
  </section>`;
}
