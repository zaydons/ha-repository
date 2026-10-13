// Fixture data served by the WS0 stubs so the frontend (WS5) can be built
// before the real services exist. Example hosts only; no real data.
// Removed or reduced once WS1/WS2 are wired into server.ts.
import type { Problem, PublicConfig, PublicGroup, StateSnapshot } from "../types.ts";

export type StubScenario = "ok" | "banner" | "fatal" | "welcome" | "empty";
export const STUB_SCENARIOS: readonly StubScenario[] = ["ok", "banner", "fatal", "welcome", "empty"];

const SETTINGS = {
  hideNoCheck: false,
  groupsInitiallyCollapsed: false,
  disableCollapse: false,
  statusIntervalS: 30,
  widgetIntervalS: 30,
};

export const FIXTURE_GROUPS: PublicGroup[] = [
  {
    id: "g-media",
    name: "Media",
    collapsed: false,
    groups: [],
    tiles: [
      {
        id: "a1b2c3d4e5f6",
        name: "Plex",
        description: "Movies & TV",
        href: "http://media.example.lan:32400/web",
        icon: { kind: "proxied", src: "icons/di/plex.png" },
        check: "http",
        widget: {
          type: "plex",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "streams", label: "Active Streams", format: "number" },
            { key: "albums", label: "Albums", format: "number" },
            { key: "movies", label: "Movies", format: "number" },
            { key: "tv", label: "TV Shows", format: "number" },
          ],
        },
      },
      {
        id: "b2c3d4e5f6a1",
        name: "Jellyfin",
        description: "Media server",
        href: "http://media.example.lan:8096/",
        icon: { kind: "proxied", src: "icons/si/jellyfin.svg" },
        check: "http",
        widget: {
          type: "jellyfin",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "movies", label: "Movies", format: "number" },
            { key: "series", label: "Series", format: "number" },
            { key: "episodes", label: "Episodes", format: "number" },
            { key: "playing", label: "Playing", format: "number" },
          ],
          nowPlaying: true,
        },
      },
      {
        id: "c3d4e5f6a1b2",
        name: "Immich",
        description: "Photos & videos",
        href: "http://media.example.lan:2283/",
        icon: { kind: "proxied", src: "icons/si/immich.svg" },
        check: "http",
        widget: {
          type: "immich",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "users", label: "Users", format: "number" },
            { key: "photos", label: "Photos", format: "number" },
            { key: "videos", label: "Videos", format: "number" },
            { key: "storage", label: "Storage", format: "bytes" },
          ],
        },
      },
      {
        id: "d4e5f6a1b2c3",
        name: "Audiobookshelf",
        description: "Audiobooks & podcasts",
        href: "http://media.example.lan:13378/",
        icon: { kind: "letter", letter: "A" },
        check: "http",
        widget: {
          type: "audiobookshelf",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "podcasts", label: "Podcasts", format: "number" },
            { key: "podcastsDuration", label: "Duration", format: "duration" },
            { key: "books", label: "Books", format: "number" },
            { key: "booksDuration", label: "Duration", format: "duration" },
          ],
        },
      },
    ],
  },
  {
    id: "g-arr",
    name: "Media Management",
    collapsed: false,
    groups: [],
    tiles: [
      {
        id: "e5f6a1b2c3d4",
        name: "Sonarr",
        description: "TV automation",
        href: "http://arr.example.lan:8989/",
        icon: { kind: "proxied", src: "icons/si/sonarr.svg" },
        check: "http",
        widget: {
          type: "sonarr",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "wanted", label: "Wanted", format: "number" },
            { key: "queued", label: "Queued", format: "number" },
            { key: "series", label: "Series", format: "number" },
          ],
        },
      },
      {
        id: "f6a1b2c3d4e5",
        name: "Radarr",
        description: "Movie automation",
        href: "http://arr.example.lan:7878/",
        icon: { kind: "proxied", src: "icons/si/radarr.svg" },
        check: "http",
        widget: {
          type: "radarr",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "wanted", label: "Wanted", format: "number" },
            { key: "missing", label: "Missing", format: "number" },
            { key: "queued", label: "Queued", format: "number" },
            { key: "movies", label: "Movies", format: "number" },
          ],
        },
      },
      {
        id: "0a1b2c3d4e5f",
        name: "SABnzbd",
        description: "Downloads",
        href: "http://arr.example.lan:8080/",
        icon: { kind: "proxied", src: "icons/si/sabnzbd.svg" },
        check: "http",
        widget: {
          type: "sabnzbd",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "rate", label: "Rate", format: "byterate" },
            { key: "queue", label: "Queue", format: "number" },
            { key: "timeleft", label: "Time Left", format: "text" },
          ],
        },
      },
      {
        id: "1b2c3d4e5f6a",
        name: "Prowlarr",
        description: "Indexers",
        href: "http://arr.example.lan:9696/",
        icon: { kind: "letter", letter: "P" },
        check: "http",
        widget: {
          type: "prowlarr",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "numberOfGrabs", label: "Grabs", format: "number" },
            { key: "numberOfQueries", label: "Queries", format: "number" },
            { key: "numberOfFailGrabs", label: "Fail Grabs", format: "number" },
            { key: "numberOfFailQueries", label: "Fail Queries", format: "number" },
          ],
        },
      },
    ],
  },
  {
    id: "g-infra",
    name: "Infrastructure",
    collapsed: false,
    groups: [
      {
        id: "g-infra-net",
        name: "Network",
        collapsed: false,
        groups: [],
        tiles: [
          {
            id: "2c3d4e5f6a1b",
            name: "Router",
            description: "Gateway",
            href: "https://router.example.lan/",
            icon: { kind: "proxied", src: "icons/mdi/router-network.svg" },
            check: "ping",
          },
          {
            id: "3d4e5f6a1b2c",
            name: "Cloudflared",
            description: "Tunnel (no link)",
            icon: { kind: "letter", letter: "C" },
            check: "none",
          },
        ],
      },
    ],
    tiles: [
      {
        id: "4e5f6a1b2c3d",
        name: "TrueNAS",
        description: "Storage",
        href: "https://nas.example.lan/",
        icon: { kind: "proxied", src: "icons/si/truenas.svg" },
        check: "http",
        widget: {
          type: "truenas",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "load", label: "System Load", format: "number" },
            { key: "uptime", label: "Uptime", format: "duration" },
            { key: "alerts", label: "Alerts", format: "number" },
          ],
        },
      },
      {
        id: "5f6a1b2c3d4e",
        name: "Proxmox",
        description: "Hypervisor (unsupported widget)",
        href: "https://pve.example.lan:8006/",
        icon: { kind: "proxied", src: "icons/si/proxmox.svg" },
        check: "http",
        widget: { type: "proxmox", supported: false, hideErrors: false, fields: [] },
      },
      {
        id: "6a1b2c3d4e5f",
        name: "Lidarr",
        description: "Music automation (widget config error)",
        href: "http://arr.example.lan:8686/",
        icon: { kind: "url", src: "https://example.com/lidarr.png" },
        check: "http",
        widget: {
          type: "lidarr",
          supported: true,
          hideErrors: false,
          fields: [
            { key: "wanted", label: "Wanted", format: "number" },
            { key: "queued", label: "Queued", format: "number" },
            { key: "artists", label: "Artists", format: "number" },
          ],
        },
      },
    ],
  },
];

const PROBLEMS: Problem[] = [
  {
    severity: "info",
    file: "services.yaml",
    line: 61,
    col: 9,
    code: "widget.unsupported",
    message: 'The "proxmox" widget isn\'t supported yet. This tile still works as a link.',
    tileId: "5f6a1b2c3d4e",
  },
  {
    severity: "warning",
    file: "services.yaml",
    line: 70,
    col: 9,
    code: "widget.config",
    message: "Lidarr widget needs `key:`. See docs.",
    tileId: "6a1b2c3d4e5f",
  },
  {
    severity: "info",
    file: "services.yaml",
    line: 12,
    col: 9,
    code: "key.ignored",
    message: "Ignored: `container: plex` (Docker integration isn't supported).",
    tileId: "a1b2c3d4e5f6",
  },
];

const FATAL: Problem = {
  severity: "error",
  file: "services.yaml",
  line: 14,
  col: 5,
  code: "yaml.parse",
  message: 'Bad indentation. Expected 2 spaces under "Media".',
  excerpt: { startLine: 13, lines: ["    - Plex:", "       icon: plex.png", "      key: ••••••"], markLine: 14 },
};

export function fixtureConfig(scenario: StubScenario, rev: number, configPath: string, loadedAt: string): PublicConfig {
  const base: PublicConfig = {
    rev,
    title: "Homelab",
    configPath,
    sampleInUse: false,
    loadedAt,
    usingLastGood: false,
    settings: { ...SETTINGS },
    groups: structuredClone(FIXTURE_GROUPS),
    problems: structuredClone(PROBLEMS),
  };
  switch (scenario) {
    case "ok":
      return base;
    case "banner":
      return { ...base, error: structuredClone(FATAL), usingLastGood: true, problems: [structuredClone(FATAL), ...base.problems] };
    case "fatal":
      return { ...base, error: structuredClone(FATAL), usingLastGood: false, groups: [], problems: [structuredClone(FATAL)] };
    case "welcome":
      return {
        ...base,
        sampleInUse: true,
        problems: [],
        groups: [
          {
            id: "g-start",
            name: "Getting started",
            collapsed: false,
            groups: [],
            tiles: [
              {
                id: "7b2c3d4e5f6a",
                name: "Home Assistant",
                description: "This dashboard's home",
                href: "http://homeassistant.local:8123/",
                icon: { kind: "proxied", src: "icons/si/homeassistant.svg" },
                check: "http",
              },
            ],
          },
        ],
      };
    case "empty":
      return { ...base, groups: [], problems: [] };
  }
}

/** State for the "ok" fixture groups. Times are relative to `now`. */
export function fixtureState(now: Date, refreshing: boolean): Omit<StateSnapshot, "rev"> {
  const t = (agoS: number) => new Date(now.getTime() - agoS * 1000).toISOString();
  const tick = Math.floor(now.getTime() / 5000) % 4; // a value that changes every 5 s
  return {
    now: now.toISOString(),
    refreshing,
    status: {
      a1b2c3d4e5f6: { state: "up", kind: "http", httpStatus: 200, latencyMs: 42, checkedAt: t(12) },
      b2c3d4e5f6a1: { state: "up", kind: "http", httpStatus: 302, latencyMs: 18, checkedAt: t(12) },
      c3d4e5f6a1b2: { state: "up", kind: "http", httpStatus: 401, latencyMs: 25, checkedAt: t(10) },
      d4e5f6a1b2c3: {
        state: "down",
        kind: "http",
        reason: "refused",
        host: "media.example.lan",
        checkedAt: t(8),
        downSince: t(14 * 60),
      },
      e5f6a1b2c3d4: { state: "up", kind: "http", httpStatus: 200, latencyMs: 9, checkedAt: t(5) },
      f6a1b2c3d4e5: {
        state: "down",
        kind: "http",
        httpStatus: 502,
        reason: "http",
        host: "arr.example.lan",
        checkedAt: t(5),
        downSince: t(120),
      },
      "0a1b2c3d4e5f": { state: "down", kind: "http", reason: "timeout", host: "arr.example.lan", checkedAt: t(3) },
      "1b2c3d4e5f6a": { state: "down", kind: "http", reason: "dns", host: "arr.example.lan", checkedAt: t(3) },
      "2c3d4e5f6a1b": { state: "up", kind: "ping", latencyMs: 3, host: "router.example.lan", checkedAt: t(7) },
      "4e5f6a1b2c3d": {
        state: "down",
        kind: "http",
        reason: "tls",
        detail: "SELF_SIGNED_CERT_IN_CHAIN",
        host: "nas.example.lan",
        checkedAt: t(6),
      },
      "5f6a1b2c3d4e": { state: "unknown", kind: "http", reason: "check_failed", detail: "EPERM", checkedAt: t(6) },
      "6a1b2c3d4e5f": { state: "up", kind: "http", httpStatus: 200, latencyMs: 30, checkedAt: t(6) },
    },
    widgets: {
      a1b2c3d4e5f6: { state: "ok", values: { streams: tick, albums: 812, movies: 1534, tv: 211 }, updatedAt: t(4), lastOkAt: t(4) },
      b2c3d4e5f6a1: {
        state: "ok",
        values: { movies: 1530, series: 209, episodes: 9876, playing: 2 },
        nowPlaying: [
          { title: "The Example Episode", subtitle: "Sample Show · S02E05", user: "alex", progressPct: 10 + tick * 20 },
          { title: "<b>Not bold</b> & friends", subtitle: "Markup must render as text", user: "sam", progressPct: 71, paused: true },
        ],
        updatedAt: t(4),
        lastOkAt: t(4),
      },
      c3d4e5f6a1b2: { state: "error", error: { kind: "auth", host: "media.example.lan", httpStatus: 403 }, updatedAt: t(4) },
      d4e5f6a1b2c3: {
        state: "error",
        values: { podcasts: 12, podcastsDuration: 351000, books: 240, booksDuration: 2880000 },
        error: { kind: "unreachable", host: "media.example.lan" },
        updatedAt: t(4),
        lastOkAt: t(65),
      },
      e5f6a1b2c3d4: { state: "ok", values: { wanted: 3, queued: tick, series: 147 }, updatedAt: t(4), lastOkAt: t(4) },
      f6a1b2c3d4e5: { state: "error", error: { kind: "timeout", host: "arr.example.lan", timeoutS: 10 }, updatedAt: t(4) },
      "0a1b2c3d4e5f": {
        state: "ok",
        values: { rate: 12_582_912, queue: 4, timeleft: "0:42:10" },
        updatedAt: t(4),
        lastOkAt: t(4),
      },
      "1b2c3d4e5f6a": { state: "loading" },
      "4e5f6a1b2c3d": { state: "error", error: { kind: "bad_response", host: "nas.example.lan", httpStatus: 200 }, updatedAt: t(4) },
      "5f6a1b2c3d4e": { state: "unsupported" },
      "6a1b2c3d4e5f": { state: "error", error: { kind: "config", message: "Lidarr widget needs `key:`. See docs." }, updatedAt: t(4) },
    },
  };
}
