// Widget plugin registry. Owned by WS3 from here on; each plugin PR appends
// one import and one array entry. (WS0 ships it empty.)
import type { WidgetPlugin } from "./types.ts";
import { audiobookshelf } from "./audiobookshelf.ts";
import { immich } from "./immich.ts";
import { jellyfin } from "./jellyfin.ts";
import { plex } from "./plex.ts";

export const plugins: WidgetPlugin[] = [
  audiobookshelf,
  immich,
  jellyfin,
  plex,
];

export function findPlugin(type: string): WidgetPlugin | undefined {
  return plugins.find((p) => p.type === type);
}
