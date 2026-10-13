# Changelog

## 0.1.0

First release (experimental).

- Homelab dashboard as a Home Assistant ingress panel ("Homelab" in the sidebar, administrators only). No host port.
- Reads Homepage-format `services.yaml` and `settings.yaml` from `/addon_configs/<id>_homelab/`. Creates sample files on first start and never overwrites them.
- Status checks with `siteMonitor` (HTTP) and `ping`.
- Widgets: audiobookshelf, immich (v1 and v2), jellyfin (count blocks and Now playing list), lidarr, plex, prowlarr, radarr, sabnzbd, sonarr, truenas (REST v1 and WebSocket v2). Field names match Homepage's.
- Secrets inline, in `secrets.yaml` with `!secret`, or with Homepage's `{{HOMEPAGE_VAR_*}}` placeholders. Secrets never reach the browser or the log.
- Config hot reload within about 5 seconds. Errors show the file, line and a redacted excerpt; the last working config stays on screen, including after a restart.
- Follows the Home Assistant theme, or a forced light or dark theme (`theme` option).
- Icons: Material Design Icons and Simple Icons built in; dashboard-icons and selfh.st icons downloaded once and cached; your own `custom-icons/` folder (tiles still use `/icons/<file>`).
- HTTPS certificate checks are off by default, as in Homepage. Turn them on with `tlsVerify: true`.
