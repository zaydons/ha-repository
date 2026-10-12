// @ts-check
// Preact + htm, served by the app from node_modules at vendor/ (no CDN, no
// bundler). htm builds virtual nodes: interpolated values are always text or
// attribute values, never parsed as HTML (threat model R1).
import { h, Fragment } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";

export const html = htm.bind(h);
export { h, Fragment };
