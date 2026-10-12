# Home Assistant Add-on: Homepage
This is an unofficial Homepage add-on for Home Assistant. It is built on top of the official Homepage image, [`ghcr.io/gethomepage/homepage`](https://github.com/gethomepage/homepage/pkgs/container/homepage) v2.5.0, with a small wrapper that adds the Home Assistant options described below.

A modern, fully static, fast, secure, fully proxied, highly customizable application dashboard with integrations for over 100 services and translations into multiple languages. Easily configured via YAML files.

## Installation
Home Assistant builds the add-on locally on first install and on every update. The build pulls the official upstream image and adds a few small files on top; nothing is compiled from source, so it only takes as long as the image download.

Click START and check the logs for "✓ Ready in ___ms".

You should be able to access Homepage at `http://<your Home Assistant IP>:3000` (for example `http://192.168.1.20:3000`) or `http://homeassistant.local:3000`.

## Upgrading from 1.0
Version 1.0 ran Homepage v1.3.2 from a third-party prebuilt image. This version runs the official Homepage v2.5.0, which is a major upgrade.

- Your configuration files are kept; they are not touched by the update.
- Leave "Create backup before updating" enabled in Home Assistant so you can roll back if needed.
- Existing YAML configs are expected to keep working. Check the [Homepage release notes](https://github.com/gethomepage/homepage/releases) for changes that might affect your widgets or services.

## Configuration
Homepage itself is configured using YAML files. These can be found in the `addon_configs/xxxxxxxx_homepage` folder. Use another add-on like Studio Code Server or File editor to edit the necessary files to [configure](https://gethomepage.dev/configs/) your page.

### Add-on options
Example configuration:

```yaml
allowed_hosts:
  - dash.lan:3000
  - homepage.home.arpa
allowed_networks:
  - 10.0.0.0/8
  - 172.16.0.0/12
  - 192.168.0.0/16
  - 169.254.0.0/16
  - fc00::/7
  - fe80::/10
  - 100.64.0.0/10 # only if you use Tailscale; not a default
```

#### Option: `allowed_hosts`
Extra host names (with port) that you use to open Homepage in your browser. Default: empty.

Homepage only answers requests whose `Host` matches its allow-list. The add-on builds that list for you (see below), so most people can leave this empty. Add an entry if you reach Homepage some other way, for example:

- a local DNS name: `dash.lan:3000`
- a reverse proxy on your home network: `homepage.home.arpa` (no port when the proxy serves on 80/443)

Entries must match exactly what appears in the browser's address bar, including the port. Wildcards (`*`) are not allowed.

The add-on adds these hosts automatically and lists them in the add-on log at startup (`Allowed hosts: ...`):

- every IP address of your Home Assistant host (except link-local IPv6 addresses), with port 3000 (e.g. `192.168.1.20:3000`)
- `homeassistant.local:3000` and `homeassistant:3000`
- your Home Assistant host name, with and without `.local`, on port 3000

`localhost:3000` and `127.0.0.1:3000` are always accepted by Homepage itself, so they are not listed in that log line.

#### Option: `allowed_networks`
Networks (in CIDR notation) that are allowed to connect to Homepage. Connections from any other address are dropped. Loopback is always allowed.

Default: the private home-network ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fc00::/7` and `fe80::/10`.

- Using a VPN to reach your home network? Add its range, e.g. `100.64.0.0/10` for Tailscale.
- You can narrow the list to just your own subnet, e.g. `192.168.1.0/24`.
- An empty list turns this check off (a warning is written to the log).

## Troubleshooting
- **Browser shows `Host validation failed` / log shows `Host validation failed for: <host>`**: you opened Homepage with an address that is not on the allow-list. Add that exact `<host>` value from the log to `allowed_hosts` and restart the add-on.
- **Page does not load / log shows `Blocked connection from <addr> (not in allowed_networks)`**: the device you are using is not in `allowed_networks`. If that address should have access (for example a VPN client), add its network to `allowed_networks` and restart the add-on.

## Security
Homepage has no login, so keep it on your home network.

- **The main protection is your router.** Do not port-forward port 3000 to Home Assistant, and disable UPnP so devices cannot open ports on their own. Home Assistant Cloud remote access does not expose add-on ports.
- `allowed_networks` is an extra layer of defence, not a replacement for the router. It cannot help if your router rewrites the source address of forwarded traffic (SNAT), or if a reverse proxy on your home network is reachable from the internet and forwards to Homepage.
- `allowed_hosts` protects against DNS rebinding attacks from a browser. It does not restrict who can connect.

## Known Issues
The port that you use to access the page is set to 3000 and it is not currently able to be changed.
