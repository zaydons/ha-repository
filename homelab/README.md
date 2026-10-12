# Home Assistant App: Homelab Dashboard

A homelab start page that opens inside Home Assistant as the **Homelab** sidebar panel. It shows your services as tiles with an up/down status and live stats from your apps, and it follows your Home Assistant theme.

- **Inside Home Assistant.** Served through ingress: no extra port, your Home Assistant login, works remotely through Home Assistant Cloud and the Companion app. The panel is visible to administrators only.
- **Homepage-compatible config.** Reads [Homepage](https://gethomepage.dev/)'s `services.yaml` and `settings.yaml`. To migrate, copy the two files into this app's config folder.
- **10 app integrations:** Audiobookshelf, Immich, Jellyfin (with Now playing), Lidarr, Plex, Prowlarr, Radarr, SABnzbd, Sonarr and TrueNAS. Other Homepage widgets become plain tiles with a link and status.
- **Keys stay on the server.** The app calls your services itself; the browser only gets the results.
- **Edit and see.** Changes to the YAML files show up within about 5 seconds. A mistake shows the file and line, and the last working dashboard stays up.

Supports amd64 and aarch64. Experimental (version 0.1).

See the **Documentation** tab (DOCS.md) for install, migration from Homepage, the supported keys and widgets, secrets and troubleshooting.
