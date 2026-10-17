# Home Assistant App: Homelab Dashboard

Homelab Dashboard puts a homelab start page in the Home Assistant sidebar. It shows your services as tiles with an up/down status and live stats from apps such as Sonarr, Plex, Jellyfin and TrueNAS.

It reads [Homepage](https://gethomepage.dev/)'s `services.yaml` and `settings.yaml` format. If you already use Homepage, you can copy your files over and most of your dashboard works unchanged. Anything this app doesn't support becomes a plain link or an info note. It never breaks the page.

What makes it different from the Homepage app in this repository:

- **It opens inside Home Assistant.** It's a sidebar panel ("Homelab"), served through Home Assistant ingress. There's no extra port to open, and you sign in with your Home Assistant login, including remotely through Home Assistant Cloud or the Companion app.
- **It follows your Home Assistant theme**, including light and dark mode.
- **Your API keys stay on the server.** The app makes every call to your services itself. The browser only gets the results.

## Contents

- [Install](#install)
- [Setup](#setup)
- [Migrating from Homepage](#migrating-from-homepage)
- [Configuration files](#configuration-files)
- [services.yaml](#servicesyaml)
- [settings.yaml](#settingsyaml)
- [Supported widgets](#supported-widgets)
- [Secrets](#secrets)
- [HTTPS and certificate checks (TLS)](#https-and-certificate-checks-tls)
- [Icons](#icons)
- [Access and remote use](#access-and-remote-use)
- [App options](#app-options)
- [Updating](#updating)
- [Fixing config errors](#fixing-config-errors)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Security and privacy](#security-and-privacy)

## Install

Requirements:

- A Home Assistant installation with the Supervisor (Home Assistant OS or Supervised), on **amd64** or **aarch64** (64-bit ARM, for example a Raspberry Pi 4 or 5 running the 64-bit OS). 32-bit systems are not supported.
- A recent Supervisor (2026.07 or newer). Older Supervisors refuse to install the app. Supervisor updates itself, so this is normally already the case.
- Internet access from Home Assistant while installing and updating. The app is built on your machine: the build downloads the Node.js base image from Docker Hub and packages from the npm registry (registry.npmjs.org).

Steps:

1. Add this repository to Home Assistant. Use the "Add repository" button in the [repository README](https://github.com/zaydons/ha-repository), or add it by hand: go to **Settings > Apps** and select **Install app**. In the top-right corner, select the three dots menu, select **Repositories**, and add `https://github.com/zaydons/ha-repository`.
2. Back on the **Install app** page, find **Homelab Dashboard** and select it, then select **Install**. The first install takes a few minutes, longer on a Raspberry Pi, because Home Assistant builds the image locally. Updates rebuild it the same way.
3. Select **Start**.
4. Open **Homelab** in the sidebar. The panel is only shown to Home Assistant administrators. On first start the app creates a sample `services.yaml` and `settings.yaml` in its config folder and shows a welcome card that tells you where that folder is.

If the build fails, check that Home Assistant can reach Docker Hub and registry.npmjs.org, then try again. See [Troubleshooting](#troubleshooting).

## Setup

The dashboard is configured with YAML files in the app's config folder:

```
/addon_configs/<id>_homelab/
```

`<id>` is a short code for the repository the app was installed from (for example `a1b2c3d4_homelab`). The welcome card and the error messages show the exact path for your install. Current versions of the editing apps show this folder as **`app_configs`** (older versions: `addon_configs`). It's the same folder.

You can edit the files with any app that can reach that folder:

| Tool | Where to find the folder |
|---|---|
| **Studio Code Server** | `/app_configs/<id>_homelab/` in the file tree (older versions: `/addon_configs/<id>_homelab/`) |
| **File editor** | `/app_configs/<id>_homelab/` (older versions: `/addon_configs/…`). File editor only shows your Home Assistant config folder by default: turn off its **Enforce basepath** option (it's on by default) to browse other folders. |
| **Samba share** | the `app_configs` share (or the older `addon_configs` share, which points at the same folder), then the `<id>_homelab` folder |
| **Terminal & SSH** | `/app_configs/<id>_homelab/` (older versions: `/addon_configs/<id>_homelab/`) |

Edit `services.yaml`, save, and the open panel updates within about 5 seconds. You don't need to restart the app. If the file has a mistake, the dashboard keeps showing the last working version and tells you the file and line to fix (see [Fixing config errors](#fixing-config-errors)).

A minimal `services.yaml`:

```yaml
- Infrastructure:
    - Router:
        icon: mdi-router-wireless
        href: http://192.168.1.1/
        description: Gateway
        ping: 192.168.1.1
    - NAS:
        icon: truenas.png
        href: https://192.168.1.20/
        siteMonitor: https://192.168.1.20/

- Media:
    - Sonarr:
        icon: sonarr.png
        href: http://192.168.1.20:8989/
        siteMonitor: http://192.168.1.20:8989/
        widget:
          type: sonarr
          url: http://192.168.1.20:8989
          key: !secret sonarr_key
```

## Migrating from Homepage

Your Homepage files work as they are. The app reads the same `services.yaml` layout, the same widget keys and the same field names.

1. Install and start Homelab Dashboard once (see [Install](#install)). This creates its config folder with sample files.
2. Copy these two files from the Homepage app's config folder into the Homelab Dashboard config folder, replacing the samples:

   | From | To |
   |---|---|
   | `/addon_configs/<id>_homepage/services.yaml` | `/addon_configs/<id>_homelab/services.yaml` |
   | `/addon_configs/<id>_homepage/settings.yaml` | `/addon_configs/<id>_homelab/settings.yaml` |

   `<id>` is the same 8-character code in both folder names, because both apps come from this repository. The Homelab panel's welcome card shows the exact folder for your install. Current editing apps show `addon_configs` as `app_configs`; it's the same folder (see [Setup](#setup)).

   - **Studio Code Server or File editor:** open each file in the `_homepage` folder, copy all of its text, and paste it over the file of the same name in the `_homelab` folder.
   - **Samba share:** open the `app_configs` (or `addon_configs`) share and copy the two files from the `_homepage` folder to the `_homelab` folder, replacing the existing files.
   - **Terminal & SSH:**

     ```sh
     cp /app_configs/<id>_homepage/services.yaml /app_configs/<id>_homepage/settings.yaml /app_configs/<id>_homelab/
     ```

     On older versions of the Terminal & SSH app, use `/addon_configs/` instead of `/app_configs/`.

3. Open the **Homelab** panel. It picks up the new files within a few seconds.
4. Select **Show all problems** in the panel if it appears. It lists everything the app ignored or didn't understand, with the file and line. Most entries are info notes about Homepage features this app doesn't have yet. See [Limitations](#limitations).

Good to know:

- **Your Homepage install is not touched.** You can run both apps side by side and remove Homepage later.
- **Only copy `services.yaml` and `settings.yaml`.** If you copy `bookmarks.yaml`, `widgets.yaml`, `docker.yaml`, `kubernetes.yaml`, `custom.css` or `custom.js` too, they're listed once as "not supported" and otherwise ignored.
- **API keys written directly in `services.yaml` keep working.** You can move them to `secrets.yaml` later (see [Secrets](#secrets)).
- **Homepage `{{HOMEPAGE_VAR_...}}` placeholders** are looked up in `secrets.yaml`, because apps in Home Assistant don't get your environment variables. If your `services.yaml` uses them (for example because it came from a Homepage install outside Home Assistant), add the values to `secrets.yaml`. See [Secrets](#secrets). `{{HOMEPAGE_FILE_...}}` isn't supported; put the value in `secrets.yaml` instead.
- **Local icons:** if a tile uses an icon such as `/icons/myapp.png`, put `myapp.png` in a `custom-icons` folder inside the Homelab Dashboard config folder. See [Icons](#icons).
- **Widgets this app doesn't support** turn into plain tiles: the link and status still work, and the stats area says "The "<type>" widget isn't supported yet." See [Supported widgets](#supported-widgets).
- **Self-signed HTTPS** keeps working, as in Homepage: certificate checks are off by default. See [HTTPS and certificate checks (TLS)](#https-and-certificate-checks-tls).

## Configuration files

Everything lives in the app's config folder, `/addon_configs/<id>_homelab/`:

| File or folder | Required | What it's for |
|---|---|---|
| `services.yaml` | yes | Your groups and tiles. Homepage format. A sample is created on first start. |
| `settings.yaml` | no | Page title, group layout and a few app settings. A sample is created on first start. |
| `secrets.yaml` | no | API keys and passwords, referenced from the other files. See [Secrets](#secrets). |
| `custom-icons/` | no | Your own icon images. See [Icons](#icons). |
| `ca.pem` | no | Extra certificate authorities to trust when certificate checks are on. See [TLS](#https-and-certificate-checks-tls). |

The app never changes your files. It only creates the two samples when they don't exist yet, and it never overwrites them.

Changes to `services.yaml`, `settings.yaml` and `secrets.yaml` apply within about 5 seconds, without a restart. New files in `custom-icons/` are used the next time the panel asks for them.

## services.yaml

The layout is the same as Homepage's: a list of groups, each with a list of services. A group can contain one level of sub-groups; deeper levels are shown as part of the sub-group.

```yaml
- Group name:
    - Service name:
        icon: ...
        href: ...
    - Sub-group:
        - Another service:
            href: ...
```

### Service keys

| Key | What it does |
|---|---|
| *(name)* | The tile title. Required. |
| `href` | The link the tile opens, in a new tab. Must start with `http://` or `https://`. A tile without `href` still shows status and stats but isn't clickable. A user name and password in the URL (`http://user:pass@host`) are removed, with a warning. |
| `description` | One line of text under the name. |
| `icon` | See [Icons](#icons). |
| `siteMonitor` | A URL to check. The app sends a `HEAD` request (or `GET` if needed) every 30 seconds. The service is **Up** for any HTTP status up to 403, so a login page (401 or 403) counts as up; redirects are not followed and also count as up. Higher codes, timeouts (5 s), refused connections and DNS failures are **Down**. |
| `ping` | A host name or IP address to ping every 30 seconds. If you set both `siteMonitor` and `ping`, only `siteMonitor` runs; `ping` is ignored and listed as info under **Show all problems**. |
| `widget` | Live stats from the app. See [Supported widgets](#supported-widgets). |
| `widgets` | A list of widgets. Only the first supported one is shown; the others are listed as info. |

A tile with neither `siteMonitor` nor `ping` shows a muted **No check** badge. Set `hideNoCheck: true` in `settings.yaml` to hide it.

Accepted but with no effect:

- `target` is accepted, but links always open in a new tab. Opening them inside the Home Assistant frame wouldn't work for most apps.
- `statusStyle`, `showStats`, `weight` and `id` are accepted silently.

Ignored with an info note, because this app doesn't do Docker, Kubernetes or Proxmox discovery: `server`, `container`, `app`, `namespace`, `podSelector`, `proxmoxNode`.

**Any other key** gives a warning with the file and line, for example `Unknown key "widgte"`. This catches typos.

## settings.yaml

| Key | What it does |
|---|---|
| `title` | Page title. Default `Homelab`. |
| `layout.<Group>.columns` | Maximum number of tile columns for that group. |
| `layout.<Group>.initiallyCollapsed` | Start that group collapsed. |
| `groupsInitiallyCollapsed` | Start all groups collapsed. |
| `disableCollapse` | Don't let groups be collapsed. |
| `hideErrors` | Default for every widget's `hideErrors` (see [Supported widgets](#supported-widgets)). |

Keys that only exist in this app:

| Key | Default | What it does |
|---|---|---|
| `tlsVerify` | `false` | Check HTTPS certificates of your services. See [TLS](#https-and-certificate-checks-tls). |
| `statusInterval` | `30` | Seconds between status checks (`siteMonitor`, `ping`). Minimum 10. |
| `widgetInterval` | `30` | Seconds between widget updates. Minimum 10. Some widgets use a longer interval (Plex: 60). |
| `hideNoCheck` | `false` | Hide the **No check** badge on tiles without `siteMonitor` or `ping`. |

Example:

```yaml
title: Homelab
tlsVerify: false
statusInterval: 30
widgetInterval: 30
hideNoCheck: false
layout:
  Media:
    columns: 3
  Infrastructure:
    initiallyCollapsed: true
```

Homepage's look-and-feel settings (`theme`, `color`, `background`, `cardBlur`, `headerStyle`, `favicon`, `language`, `quicklaunch`, `useEqualHeights`, `fullWidth`, `layout.<Group>.style`/`icon`/`header`/`tab`, and so on) are accepted silently and have no effect. The page follows your Home Assistant theme instead. `providers` gives an info note: put the key in the widget or in `secrets.yaml` instead.

## Supported widgets

These Homepage widget types are supported, with Homepage's config keys and field names. Each tile shows **at most 4 fields**. Use `fields:` to choose which ones and in what order; without it, the defaults below are shown.

| Widget `type` | Config keys | Fields (label) | Shown by default |
|---|---|---|---|
| `audiobookshelf` | `url`, `key` | `podcasts` (Podcasts), `podcastsDuration` (Duration), `books` (Books), `booksDuration` (Duration) | all 4 |
| `immich` | `url`, `key`; optional `version` (`1` default, `2` for Immich 1.118 and newer) | `users` (Users), `photos` (Photos), `videos` (Videos), `storage` (Storage) | all 4 |
| `jellyfin` | `url`, `key`; optional `version`, `enableBlocks`, `enableNowPlaying`, `enableUser`, `showEpisodeNumber`, `expandOneStreamToTwoRows`, `enableMediaControl` (see the note below) | `movies` (Movies), `series` (Series), `episodes` (Episodes), `songs` (Songs), `albums` (Albums), `playing` (Playing), plus a **Now playing** list | `movies`, `series`, `episodes`, `playing` |
| `lidarr` | `url`, `key` | `wanted` (Wanted), `queued` (Queued), `artists` (Artists) | all 3 |
| `plex` | `url`, `key` (your X-Plex-Token) | `streams` (Active Streams), `albums` (Albums), `movies` (Movies), `tv` (TV Shows) | all 4 |
| `prowlarr` | `url`, `key` | `numberOfGrabs` (Grabs), `numberOfQueries` (Queries), `numberOfFailGrabs` (Fail Grabs), `numberOfFailQueries` (Fail Queries) | all 4 |
| `radarr` | `url`, `key`; optional `enableQueue` (ignored, info note) | `wanted` (Wanted), `missing` (Missing), `queued` (Queued), `movies` (Movies) | all 4 |
| `sabnzbd` | `url`, `key` | `rate` (Rate), `queue` (Queue), `timeleft` (Time Left) | all 3 |
| `sonarr` | `url`, `key`; optional `enableQueue` (ignored, info note) | `wanted` (Wanted), `queued` (Queued), `series` (Series) | all 3 |
| `truenas` | `url`, and either `key` or `username` + `password`; optional `version` (`1` default, `2` for the WebSocket API), `enablePools`, `nasType` (accepted; pools aren't shown) | `load` (System Load), `uptime` (Uptime), `alerts` (Alerts) | all 3 |

Keys every widget accepts:

| Key | What it does |
|---|---|
| `type` | Widget type from the table above. Required. |
| `url` | Base URL of the app, as you'd open it from Home Assistant's network. Keep any sub-path (for example `http://192.168.1.20:8080/sonarr`). |
| `fields` | List of field names to show, in order. Up to 4 are shown; unknown names give a warning. |
| `hideErrors` | `true` shows a muted "—" instead of an error message when the widget can't load. |
| `tlsVerify` | `true` or `false` for this widget's requests only, overriding the `settings.yaml` value. It doesn't affect the tile's `siteMonitor` check, which always uses the `settings.yaml` value. |
| `headers` | Extra HTTP headers to send, as a map. |

Notes per widget:

- **Immich:** the API key needs the `server.statistics` permission. Use `version: 2` for Immich 1.118 and newer.
- **Jellyfin:** `enableBlocks: true` shows the count blocks (Movies, Series and so on). `enableNowPlaying` adds a **Now playing** list under them; it's on unless you set `enableNowPlaying: false`, as in Homepage. The list shows:
  - up to 2 sessions, each with a play or pause symbol, the title, a second line, and a progress bar with the percentage;
  - "+N more" when more are playing (the **Playing** count always shows the full number);
  - "Nothing playing" when nothing is.

  The second line is the series name for an episode, the year for a movie, or the artist and album for music. `showEpisodeNumber: true` adds the episode number (for example `S02E05`). User names are shown only with `enableUser: true`, as in Homepage. `expandOneStreamToTwoRows` is accepted and has no effect, because every session already takes two lines. There's no artwork. Media controls (`enableMediaControl`) aren't supported, because the dashboard is read-only; the key gives an info note under **Show all problems**.

  Without `enableBlocks: true` the tile shows only the Now playing list, as in Homepage.
- **Plex:** updates every 60 seconds, because counting library items takes a few requests.
- **SABnzbd:** its API only accepts the key in the URL. The app removes it from logs and error messages.
- **TrueNAS:** use `version: 2` on TrueNAS 25.04 and newer; TrueNAS 26.04 removed the REST API that `version: 1` uses. With `version: 2` and an API key, the app always connects over secure WebSocket (`wss://`), because TrueNAS refuses API keys over unencrypted connections. If the `url` starts with `http://`, the app still uses `wss://` on the same host (port 443 unless you give a port).

Example with a chosen field order:

```yaml
- Media:
    - Radarr:
        icon: radarr.png
        href: http://192.168.1.20:7878/
        siteMonitor: http://192.168.1.20:7878/
        widget:
          type: radarr
          url: http://192.168.1.20:7878
          key: !secret radarr_key
          fields: ["movies", "missing", "queued"]
    - TrueNAS:
        icon: truenas.png
        href: https://192.168.1.20/
        siteMonitor: https://192.168.1.20/
        widget:
          type: truenas
          version: 2
          url: https://192.168.1.20
          key: !secret truenas_key
```

**Other widget types** from Homepage aren't supported yet. The tile keeps its link and status; its stats area shows an info note, and the type is listed once under **Show all problems**. This isn't counted as an issue in the header.

Widgets only update while someone has the panel open. About 2 minutes after the last viewer leaves, widget requests stop; they restart as soon as you open the panel again. Status checks keep running all the time, so "Down since" is accurate.

## Secrets

You have three ways to provide API keys and passwords. Use whichever suits you; you can mix them.

**1. Inline**, as in most Homepage configs. This works, but the key sits in `services.yaml`:

```yaml
widget:
  type: sonarr
  url: http://192.168.1.20:8989
  key: 0123456789abcdef0123456789abcdef
```

**2. `!secret`**, the same way Home Assistant's own `secrets.yaml` works. Create `secrets.yaml` in the app's config folder:

```yaml
# /addon_configs/<id>_homelab/secrets.yaml
sonarr_key: 0123456789abcdef0123456789abcdef
truenas_key: 1-abcdefghijklmnopqrstuvwxyz
```

and refer to it in `services.yaml`:

```yaml
widget:
  type: sonarr
  url: http://192.168.1.20:8989
  key: !secret sonarr_key
```

This is a separate file from Home Assistant's own `secrets.yaml`; the app can't read that one.

**3. Homepage placeholders**, so a copied Homepage config works as is:

```yaml
widget:
  type: sonarr
  url: http://192.168.1.20:8989
  key: "{{HOMEPAGE_VAR_SONARR_KEY}}"
```

`{{HOMEPAGE_VAR_SONARR_KEY}}` is looked up in `secrets.yaml` under `HOMEPAGE_VAR_SONARR_KEY` or just `SONARR_KEY`:

```yaml
SONARR_KEY: 0123456789abcdef0123456789abcdef
```

`{{HOMEPAGE_FILE_...}}` isn't supported; put the value in `secrets.yaml`.

If a secret is missing, only the tile that uses it shows an error. The rest of the dashboard loads normally.

### Where secrets go, and where they don't

- **Never to the browser.** The app makes every request to your services itself. The panel only receives names, links, icons and the results (status, numbers). Widget settings, check URLs and keys are never sent to it.
- **Never in the log or error messages.** Known secret values, and URL parameters such as `apikey` or `token`, are replaced with `••••` at every log level, including `debug`. Config error excerpts hide values of keys like `key`, `token` and `password`.
- **In your Home Assistant backups.** Backups include the app's config folder and its private data, which hold your API keys and passwords. Use encrypted backups (Home Assistant's default, with your backup encryption key) and keep the key safe, as you would for Home Assistant's own `secrets.yaml`. Be careful with unencrypted backup copies or downloads.
- The app keeps a copy of the last working config, keys included, in its private `/data` folder so the dashboard survives a broken edit across restarts. Only the app can read it.

## HTTPS and certificate checks (TLS)

By default the app **doesn't check HTTPS certificates** when it talks to your services, the same as Homepage. Homelab apps often use self-signed certificates, and this way a migrated config just works. The app writes this line to its log at start:

```
TLS verification is off for widget/status requests (settings.yaml tlsVerify)
```

**What this means:** someone who can intercept traffic on your home network could pretend to be one of your services and capture the API key the app sends to it. On a trusted home network that's usually acceptable. If it isn't for you, turn checking on:

```yaml
# settings.yaml: check certificates for every service
tlsVerify: true
```

or per widget (this covers the widget's requests only, not the tile's `siteMonitor` check):

```yaml
widget:
  type: truenas
  url: https://192.168.1.20
  key: !secret truenas_key
  tlsVerify: true
```

With checking on, the app trusts the usual public certificate authorities. If your services use certificates from your own CA (for example a home CA or a reverse proxy's internal CA), put that CA's certificate in PEM format in the config folder as `ca.pem`. It's trusted in addition to the public ones. Changes to `ca.pem` apply within about 5 seconds, without a restart.

Status checks (`siteMonitor`) always use the `tlsVerify` value in `settings.yaml`; a widget's own `tlsVerify` doesn't change them. So with checking on, a bad certificate shows the service as **Down** with a TLS error, and the fix is to add the CA to `ca.pem` or set `tlsVerify: false` in `settings.yaml`. A widget that fails with a certificate error can also be fixed with `tlsVerify: false` on that widget, but that doesn't change the tile's status.

## Icons

The `icon` key uses Homepage's names:

| `icon` value | Where it comes from | Works offline |
|---|---|---|
| `mdi-<name>`, e.g. `mdi-router-wireless` | Material Design Icons, built into the app. Add a colour with `mdi-<name>-#rrggbb`. | yes |
| `si-<name>`, e.g. `si-jellyfin` | Simple Icons, built into the app. `si-<name>-#rrggbb` also works. | yes |
| `<name>`, `<name>.png`, `<name>.svg`, `<name>.webp`, e.g. `sonarr.png` | [dashboard-icons](https://github.com/homarr-labs/dashboard-icons). The app downloads each icon once from cdn.jsdelivr.net and keeps it. No extension means `.png`. | after the first download |
| `sh-<name>` (optionally with `.png`, `.svg` or `.webp`) | [selfh.st icons](https://github.com/selfhst/icons), downloaded and kept the same way | after the first download |
| `/icons/<file>`, or any file name that exists in your `custom-icons/` folder | Your own image in `/addon_configs/<id>_homelab/custom-icons/`. `/icons/<file>` is Homepage's syntax and keeps working unchanged. Your folder wins over dashboard-icons when both have the same name. | yes |
| `https://...` | Loaded by your browser directly from that address | depends on that address |

If an icon can't be found or downloaded, the tile shows the first letter of the service name instead.

Notes:

- The app downloads icons itself, so your browser never contacts the icon CDN. Downloaded icons are kept in the app's private storage (up to 50 MB) and are left out of backups.
- A name that doesn't exist is remembered for 24 hours before the app tries again; a failed download is retried after about 10 minutes.
- Icon names must be lower case: letters, digits, `.`, `_` and `-`.
- The folder is called `custom-icons`, not `icons`, because Home Assistant's Samba share hides any file or folder whose name matches `icon?` by default (so `icons` would be invisible over Samba).
- A full `https://` icon URL that points at your home network won't load when you use the dashboard away from home. Put the file in `custom-icons/` instead.

## Access and remote use

- The **Homelab** panel is only visible to Home Assistant **administrators**.
- The app has no login of its own and no open port. You reach it through Home Assistant, so it works anywhere Home Assistant works: at home, through Home Assistant Cloud (Nabu Casa) or your own remote access, and in the Companion app.
- **Status and stats work remotely**, because the app checks your services from inside your network.
- **Tile links don't work remotely**, unless you're connected to your home network some other way (for example a VPN). Links are your services' home-network addresses, such as `http://192.168.1.20:8989`, and they open in a new tab or in your phone's browser, outside Home Assistant. Remote access to Home Assistant only covers Home Assistant itself.
- The dashboard is read-only. The only thing it lets you do is refresh; you can't change anything in your services from it.

## App options

Set this on the app's **Configuration** tab in Home Assistant. Everything else lives in the YAML files.

| Option | Values | Default | What it does |
|---|---|---|---|
| `log_level` | `debug`, `info`, `warning`, `error` | `info` | How much the app writes to its log. Use `debug` only while troubleshooting. Secrets are hidden at every level. |

Restart the app after changing an option. Options are read once at start, and saving them doesn't restart the app.

There's no theme option. The dashboard always follows your Home Assistant theme, including custom themes and live changes. If you open it outside Home Assistant, it follows your device's light or dark setting.

## Updating

New versions show up in Home Assistant as **Update available**: under **Settings**, and on the app's **Info** tab. Most are dependency and security updates; the release notes in the update dialog say what changed (the same text as the [changelog](CHANGELOG.md)). Home Assistant doesn't install them on its own unless you turn on **Auto update** on the app's **Info** tab.

- **Back up first.** When you select **Update**, Home Assistant offers to create a backup of the app before updating. Leave that on. If the new version gives you trouble, restore that backup in **Settings > System > Backups** to go back to the version you had.
- **It takes a few minutes.** Home Assistant rebuilds the app on your machine, just like the first install, so it needs to reach Docker Hub and registry.npmjs.org again.
- **Your dashboard is kept.** Your config folder (`services.yaml`, `settings.yaml`, `secrets.yaml`, `custom-icons/`) and the app options stay as they are.

## Fixing config errors

When a file has a mistake, the app tells you exactly where it is.

- **The file can't be read at all** (for example bad indentation, a tab character or an unclosed quote): a banner at the top of the panel names the file, line and column, explains the problem and shows the lines around it. The dashboard keeps showing the **last working config**, with live status, until you fix it. This also survives an app restart.
- **The very first config has an error** (so there's no last working version): the panel shows a full-page error with the same details instead of tiles.
- **One service has a problem** (for example `href` isn't a URL, or a widget is missing `url` or `key`): only that tile shows a message with the line number. Everything else loads.
- **Warnings and info notes** (unknown keys, ignored Homepage features, unsupported widgets) are collected under **Show all problems**, each with its file and line.

Save the fixed file and the banner disappears within about 5 seconds, with a "Config reloaded" message.

Common messages:

| Message | Fix |
|---|---|
| Tabs aren't allowed in YAML. Use spaces. | Replace tab characters with spaces. |
| Bad indentation. Check the spaces before this line. | Line up the key with the others at the same level. Service keys sit two spaces deeper than the service name. |
| "key" appears twice in the same block. | Remove or rename one of them. |
| Unknown key "…" | Usually a typo, such as `widgte:` for `widget:`. |
| Unknown setting "…" for the … widget. | That widget doesn't have this key. Check the [widget table](#supported-widgets). |
| … widget needs `key:`. | Add the missing key, or check the `!secret` name. |

Values of keys such as `key`, `token` and `password` are hidden in the excerpts, so you can share a screenshot.

## Troubleshooting

### Status badges

| Badge | Meaning |
|---|---|
| **Up** | The check succeeded. Hover for the HTTP code or ping time. |
| **Down** | The check failed. The reason is shown on the tile and in the tooltip: HTTP code, no response within 5 s, connection refused, can't resolve the host name, no ping reply, or a TLS certificate error. |
| **No check** | The service has no `siteMonitor` or `ping`. |
| **Unknown** | The app couldn't run the check itself (not the service's fault). It retries automatically. |

### Widget messages

A widget error never changes the status badge: a service can be **Up** while its widget can't sign in.

| Message | What to check |
|---|---|
| Sign-in failed. Check the API key/username for … | The `key` (or `username`/`password`) is wrong, or lacks permissions (Immich needs `server.statistics`). |
| Can't reach … at http://… Check the widget `url`. | The `url` must be reachable from Home Assistant, not just from your computer. Check the address and port. |
| … didn't answer within 10 s. | The app is slow or overloaded. It retries automatically. |
| … sent a response we couldn't read. | Wrong `url` (for example pointing at a login page or a reverse proxy redirect), or an app version this widget doesn't support yet. Redirects are not followed, so use the app's direct address. Check `version` for Immich and TrueNAS. |
| … widget needs `key:` | Config problem; see [Fixing config errors](#fixing-config-errors). |
| The "…" widget isn't supported yet. | That Homepage widget type isn't in this app; the tile still works as a link. |
| Values shown faded with a clock | The latest update failed; these are the last values the app got. |

### Logs

Open the app's **Log** tab in Home Assistant. Useful lines:

- `Config loaded: 4 groups, 19 services, 10 widgets (2 warnings)`: the config loaded.
- `Config error: services.yaml:14:5 Bad indentation…`: the config couldn't be read; the panel shows the same error.
- `TLS verification is off for widget/status requests`: normal; see [TLS](#https-and-certificate-checks-tls).
- `services.yaml exists but the app (uid 1000) can't read it`: the file's permissions are too strict. Make it readable, for example `chmod 644 services.yaml` in Terminal & SSH.

For more detail, set `log_level` to `debug`, restart the app and reproduce the problem. Set it back to `info` afterwards. Secrets are hidden at every level, but the log does contain your service names and addresses, so check it before you share it.

### Other problems

- **Install or update fails during the build:** Home Assistant must reach Docker Hub and registry.npmjs.org while building. Check your internet connection and DNS (and any ad-blocker on your network), then try again.
- **The panel says "Stale: updated … ago":** the browser can't reach the app. Check that the app is running (the app's **Info** tab) and look at its log.
- **The panel is missing from the sidebar:** you're not signed in as an administrator, or **Show in sidebar** is off on the app's **Info** tab.
- **Tiles don't open when I'm away from home:** expected; see [Access and remote use](#access-and-remote-use).
- **Every widget shows an error after migrating:** if Homepage got its keys from environment variables (`{{HOMEPAGE_VAR_...}}`), add those values to `secrets.yaml`; see [Secrets](#secrets).

## Limitations

Version 0.1 covers service tiles, status checks and the widgets listed above. Not supported yet:

- Homepage's top info widgets (`widgets.yaml`: weather, search, resources and so on), bookmarks, custom CSS/JS and backgrounds.
- Other Homepage widget types. They become plain tiles with a link and status.
- More than one widget per tile, and more than 4 fields per widget.
- Jellyfin artwork and media controls, and more than 2 rows in the Now playing list.
- Docker, Kubernetes and Proxmox discovery (`server`, `container`, `proxmoxNode` and similar).
- Opening links anywhere but a new tab.
- Different links for home and remote use.
- Editing the dashboard from the panel. You edit the YAML files.
- Home Assistant entities on tiles.
- 32-bit systems (armv7, armhf, i386).

## Security and privacy

- **No open ports.** The app is only reachable through Home Assistant ingress, and it refuses connections from anywhere except Home Assistant's Supervisor.
- **Admin-only panel**, behind your Home Assistant login. The app shows up as **Homelab** in the sidebar for administrators only.
- **Backups contain your keys.** Keep Home Assistant backups encrypted; see [Secrets](#secrets).
- **Runs as a non-root user**, with no extra privileges, host network or device access.
- **Secrets stay on the server**; see [Secrets](#secrets).
- **The app only contacts** the addresses in your config (your services) and, for icons, cdn.jsdelivr.net. It sends nothing else anywhere: no telemetry.
- **Read-only.** The panel can't change anything in your services.
- **Certificate checks are off by default**; see [TLS](#https-and-certificate-checks-tls) for the risk and how to turn them on.
