// Widget plugin registry. Owned by WS3 from here on; each plugin PR appends
// one import and one array entry. (WS0 ships it empty.)
import type { WidgetPlugin } from "./types.ts";
import { sabnzbd } from "./sabnzbd.ts";
import { truenas } from "./truenas.ts";

export const plugins: WidgetPlugin[] = [sabnzbd, truenas];

export function findPlugin(type: string): WidgetPlugin | undefined {
  return plugins.find((p) => p.type === type);
}
