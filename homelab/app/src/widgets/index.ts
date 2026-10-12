// Widget plugin registry. Owned by WS3; each plugin PR appends one import and
// one array entry.
import type { WidgetPlugin } from "./types.ts";
import { sonarr } from "./sonarr.ts";
import { radarr } from "./radarr.ts";
import { lidarr } from "./lidarr.ts";
import { prowlarr } from "./prowlarr.ts";
import { audiobookshelf } from "./audiobookshelf.ts";
import { immich } from "./immich.ts";
import { jellyfin } from "./jellyfin.ts";
import { plex } from "./plex.ts";

export const plugins: WidgetPlugin[] = [sonarr, radarr, lidarr, prowlarr, audiobookshelf, immich, jellyfin, plex];

export function findPlugin(type: string): WidgetPlugin | undefined {
  return plugins.find((p) => p.type === type);
}
