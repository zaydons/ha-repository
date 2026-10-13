# ha-repository
The repository for my Home Assistant add-ons.

[![Open your Home Assistant instance and show the add add-on repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fzaydons%2Fha-repository)
## Add-ons
This repository contains the following add-ons.
### [Homepage](https://github.com/zaydons/ha-repository/tree/main/homepage)
An unofficial app for [Homepage](https://gethomepage.dev/), built on the official image. It opens on its own port (3000), outside the Home Assistant sidebar.

### [Homelab Dashboard](https://github.com/zaydons/ha-repository/tree/main/homelab)
A homelab dashboard that opens inside Home Assistant as the "Homelab" sidebar panel (admin-only, through ingress, no extra port). It shows service tiles with up/down status and live stats from Audiobookshelf, Immich, Jellyfin, Lidarr, Plex, Prowlarr, Radarr, SABnzbd, Sonarr and TrueNAS, and follows your Home Assistant theme. It reads Homepage's `services.yaml` and `settings.yaml`, so you can migrate by copying those two files. Experimental. See the [documentation](homelab/DOCS.md).
