import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "../../src/config/load.ts";
import type { BuildResult, BuiltConfig, SourceTexts } from "../../src/config/load.ts";
import { project } from "../../src/config/project.ts";
import { tileIdFor } from "../../src/config/validate.ts";
import type { Problem, PublicConfig } from "../../src/types.ts";
import { stubIcons, stubPlugins } from "../support/stub-plugins.ts";

const FIX = fileURLToPath(new URL("../fixtures/config/", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../../sample/", import.meta.url));

function build(services: string | null, settings: string | null = null, secrets: string | null = null, ignoredFiles: string[] = []): BuildResult {
  return buildConfig({ services, settings, secrets }, { plugins: stubPlugins, icons: stubIcons(), ignoredFiles });
}
function ok(r: BuildResult): BuiltConfig {
  if (!r.ok) assert.fail(`expected ok, got fatal: ${JSON.stringify(r.error)}`);
  return r;
}
function projectOf(b: BuiltConfig): PublicConfig {
  return project({
    rev: 1,
    theme: "auto",
    configPath: "/addon_configs/x_homelab/",
    sampleInUse: false,
    loadedAt: "2026-10-12T00:00:00.000Z",
    settings: b.settings,
    groups: b.groups,
    problems: b.problems,
    usingLastGood: false,
    hardSecrets: b.hardSecrets,
  });
}
function codes(ps: Problem[]): string[] {
  return ps.map((p) => p.code);
}
function allTiles(cfg: PublicConfig) {
  return cfg.groups.flatMap((g) => [...g.tiles, ...g.groups.flatMap((s) => s.tiles)]);
}

// ---------------------------------------------------------------------------
// Migration fixture (AC5)
// ---------------------------------------------------------------------------

function checkOwnerLike(src: SourceTexts, sentinels: string[]) {
  const b = ok(buildConfig(src, { plugins: stubPlugins, icons: stubIcons() }));
  const errorsOrWarnings = b.problems.filter((p) => p.severity !== "info");
  assert.deepEqual(errorsOrWarnings, [], "no errors or warnings");
  assert.equal(b.counts.groups, 4);
  assert.equal(b.counts.services, 16);
  assert.equal(b.counts.widgets, 10);
  const cfg = projectOf(b);
  assert.deepEqual(cfg.groups.map((g) => g.name), ["Media", "Media Management", "Files & Tools", "Infrastructure"]);
  const tiles = allTiles(cfg);
  const hex = tiles.find((t) => t.name === "HexOS")!;
  const cf = tiles.find((t) => t.name === "Cloudflared")!;
  assert.equal(hex.href, undefined, "HexOS is a valid non-link tile");
  assert.equal(cf.href, undefined, "Cloudflared is a valid non-link tile");
  assert.equal(hex.check, "none");
  assert.ok(!b.problems.some((p) => p.tileId === hex.id || p.tileId === cf.id), "no problems for the href-less tiles");
  const jf = tiles.find((t) => t.name === "Jellyfin")!;
  assert.equal(jf.widget?.nowPlaying, true);
  assert.deepEqual(jf.widget?.fields.map((f) => f.key), ["movies", "series", "episodes", "playing"]);
  const tn = tiles.find((t) => t.name === "TrueNAS")!;
  assert.deepEqual(tn.widget?.fields.map((f) => f.key), ["load", "uptime", "alerts"]);
  // Only expected info notes: providers (settings) and enablePools (truenas).
  assert.deepEqual(new Set(b.problems.map((p) => p.code)), new Set(["key.ignored"]));
  const json = JSON.stringify(cfg);
  for (const s of sentinels) assert.ok(!json.includes(s), `projection must not contain ${s}`);
  for (const k of ["siteMonitor", "\"url\"", "\"cfg\"", "\"enablePools\"", "192.0.2.31:32400\"", "8096\""]) assert.ok(!json.includes(k), `projection must not contain ${k}`);
  return { b, cfg };
}

test("migration fixture: Homepage services + settings load unedited with zero errors", () => {
  const services = readFileSync(join(FIX, "homepage-services.yaml"), "utf8");
  const settings = readFileSync(join(FIX, "homepage-settings.yaml"), "utf8");
  const sentinels = [...services.matchAll(/SENTINEL-K-\d{4}-7f3a/g)].map((m) => m[0]);
  assert.equal(sentinels.length, 10);
  const { b } = checkOwnerLike({ services, settings, secrets: null }, [...sentinels, "openweathermapapikey", "weatherapiapikey"]);
  for (const s of sentinels) assert.ok(b.secrets.includes(s), "inline keys are registered for log redaction");
  // NormalisedConfig carries the resolved keys for the scheduler.
  const plex = b.tiles.find((t) => t.name === "Plex")!;
  assert.equal(plex.widget?.cfg.key, sentinels[0]);
  assert.deepEqual(plex.check, { kind: "http", url: "http://192.0.2.31:32400/web" });
});

// The owner's real (redacted) files live outside the repo; run with
// HL_OWNER_FIXTURE_DIR=<dir containing owner-services.yaml and owner-settings.yaml>.
const ownerDir = process.env.HL_OWNER_FIXTURE_DIR;
test("owner fixture (external): owner-services.yaml + owner-settings.yaml load with zero errors", { skip: !ownerDir || !existsSync(join(ownerDir ?? "", "owner-services.yaml")) }, () => {
  const services = readFileSync(join(ownerDir!, "owner-services.yaml"), "utf8");
  const settings = readFileSync(join(ownerDir!, "owner-settings.yaml"), "utf8");
  checkOwnerLike({ services, settings, secrets: null }, ["openweathermapapikey", "weatherapiapikey"]);
});

test("shipped sample loads with zero problems", () => {
  const b = ok(build(readFileSync(join(SAMPLE, "services.yaml"), "utf8"), readFileSync(join(SAMPLE, "settings.yaml"), "utf8")));
  assert.deepEqual(b.problems, []);
  assert.ok(b.counts.services >= 1);
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRETS = `
sonarr_key: SENTINEL-SECRET-TAG-0001
HOMEPAGE_VAR_RADARR_KEY: SENTINEL-VAR-FULL-0002
LIDARR_KEY: SENTINEL-VAR-SHORT-0003
nas_pass: SENTINEL-PASS-0004
unused_one: SENTINEL-UNUSED-0005
`;
const SERVICES_WITH_SECRETS = `
- Apps:
    - Sonarr:
        href: http://sonarr.lan:8989/
        widget:
          type: sonarr
          url: http://sonarr.lan:8989
          key: !secret sonarr_key
    - Radarr:
        href: http://radarr.lan:7878/
        widget:
          type: radarr
          url: http://radarr.lan:7878
          key: "{{HOMEPAGE_VAR_RADARR_KEY}}"
    - Lidarr:
        widget:
          type: lidarr
          url: http://lidarr.lan:8686
          key: "{{HOMEPAGE_VAR_LIDARR_KEY}}"
    - NAS:
        href: http://admin:SENTINEL-USERINFO-0006@nas.lan/
        siteMonitor: http://mon:SENTINEL-MON-0007@nas.lan/
        widget:
          type: truenas
          url: https://nas.lan
          username: admin-SENTINEL-USER-0008
          password: !secret nas_pass
    - SAB:
        siteMonitor: http://sab.lan:8080/api?mode=version&apikey=SENTINEL-QUERY-0009
        widget:
          type: sabnzbd
          url: http://sab.lan:8080
          key: SENTINEL-INLINE-0010
          headers:
            X-Extra: SENTINEL-HEADER-0011
    - Pasted:
        description: SENTINEL-INLINE-0010
`;

test("secrets: !secret, HOMEPAGE_VAR_ (full and short name) resolve; nothing leaks into the projection", () => {
  const b = ok(build(SERVICES_WITH_SECRETS, null, SECRETS));
  const byName = (n: string) => b.tiles.find((t) => t.name === n)!;
  assert.equal(byName("Sonarr").widget?.cfg.key, "SENTINEL-SECRET-TAG-0001");
  assert.equal(byName("Radarr").widget?.cfg.key, "SENTINEL-VAR-FULL-0002");
  assert.equal(byName("Lidarr").widget?.cfg.key, "SENTINEL-VAR-SHORT-0003");
  assert.equal(byName("NAS").widget?.cfg.password, "SENTINEL-PASS-0004");
  assert.equal(byName("NAS").widget?.configError, undefined);
  assert.deepEqual(byName("SAB").widget?.cfg.headers, { "X-Extra": "SENTINEL-HEADER-0011" });

  const json = JSON.stringify(projectOf(b));
  const all = json.match(/SENTINEL-[A-Z-]+-\d{4}/g);
  assert.equal(all, null, `projection leaked: ${all?.join(", ")}`);
  const cfg = projectOf(b);
  const nas = allTiles(cfg).find((t) => t.name === "NAS")!;
  assert.equal(nas.href, "http://nas.lan/", "userinfo stripped from href");
  assert.ok(b.problems.some((p) => p.code === "item.href.userinfo" && p.tileId === nas.id));
  const pasted = allTiles(cfg).find((t) => t.name === "Pasted")!;
  assert.equal(pasted.description, "••••", "a key pasted into a description is scrubbed");

  for (const s of ["SENTINEL-SECRET-TAG-0001", "SENTINEL-VAR-FULL-0002", "SENTINEL-UNUSED-0005", "SENTINEL-USERINFO-0006", "SENTINEL-MON-0007", "admin-SENTINEL-USER-0008", "SENTINEL-QUERY-0009", "SENTINEL-INLINE-0010", "SENTINEL-HEADER-0011"]) {
    assert.ok(b.secrets.includes(s), `log secrets include ${s}`);
  }
});

test("secrets: missing !secret / HOMEPAGE_VAR is an item error on that tile only", () => {
  const b = ok(
    build(`
- G:
    - A:
        widget:
          type: sonarr
          url: http://a.lan
          key: !secret nope
    - B:
        href: http://b.lan/
        widget:
          type: sonarr
          url: http://b.lan
          key: "{{HOMEPAGE_VAR_MISSING}}"
    - C:
        href: "{{HOMEPAGE_FILE_KEY}}"
    - D:
        href: http://d.lan/
`),
  );
  const t = (n: string) => b.tiles.find((x) => x.name === n)!;
  assert.match(t("A").widget!.configError!, /Secret "nope" isn't in secrets.yaml/);
  assert.match(t("B").widget!.configError!, /HOMEPAGE_VAR_MISSING/);
  assert.equal(t("D").widget, undefined);
  const missing = b.problems.filter((p) => p.code === "secret.missing");
  assert.deepEqual(missing.map((p) => p.tileId).sort(), [t("A").id, t("B").id].sort());
  assert.equal(missing.find((p) => p.tileId === t("A").id)!.line, 7);
  assert.ok(b.problems.some((p) => p.code === "secret.unsupported" && p.tileId === t("C").id));
  const cfg = projectOf(b);
  assert.equal(allTiles(cfg).find((x) => x.name === "C")!.href, undefined);
});

// ---------------------------------------------------------------------------
// Validation (design §4.2)
// ---------------------------------------------------------------------------

test("validation: unknown keys warn with file:line; discovery keys are info; silent keys are silent", () => {
  const b = ok(
    build(`- G:
    - Plex:
        href: http://plex.lan/
        widgte:
          type: plex
        container: plex
        server: my-docker
        weight: 3
        target: _self
        statusStyle: dot
`),
  );
  const unknown = b.problems.find((p) => p.code === "key.unknown")!;
  assert.equal(unknown.severity, "warning");
  assert.equal(unknown.file, "services.yaml");
  assert.equal(unknown.line, 4);
  assert.match(unknown.message, /widgte/);
  assert.equal(unknown.excerpt?.markLine, 4);
  assert.equal(unknown.excerpt?.startLine, 3);
  const ignored = b.problems.filter((p) => p.code === "key.ignored");
  assert.equal(ignored.length, 2);
  assert.ok(ignored.every((p) => p.severity === "info"));
  assert.match(ignored[0]!.message, /Ignored `container` in services.yaml line 6: Docker integration isn't supported/);
  assert.equal(b.problems.length, 3);
});

test("validation: href must be http(s); javascript:/data:/relative become non-link tiles with a problem", () => {
  const b = ok(
    build(`- G:
    - A:
        href: javascript:alert(1)
    - B:
        href: "data:text/html,<script>alert(1)</script>"
    - C:
        href: /relative
    - D:
        href: https://ok.lan/path?q=1
    - E:
        href: ftp://files.lan/
`),
  );
  const cfg = projectOf(b);
  const tiles = allTiles(cfg);
  for (const n of ["A", "B", "C", "E"]) assert.equal(tiles.find((t) => t.name === n)!.href, undefined, n);
  assert.equal(tiles.find((t) => t.name === "D")!.href, "https://ok.lan/path?q=1");
  assert.equal(b.problems.filter((p) => p.code === "item.href").length, 4);
  assert.ok(!JSON.stringify(cfg.groups).includes("javascript:"));
});

test("validation: icons are passed to resolve() only as validated names or http(s) URLs", () => {
  const icons = stubIcons();
  const b = buildConfig(
    {
      services: `- G:
    - A:
        icon: mdi-server
    - B:
        icon: javascript:alert(1)
    - C:
        icon: "data:image/svg+xml,<svg onload=alert(1)>"
    - D:
        icon: https://user:pw@icons.lan/x.png
    - E:
        icon: https://icons.lan/x.png
    - F:
        icon: ../../etc/passwd
    - G2:
        icon: /icons/local.png
    - H:
`,
      settings: null,
      secrets: null,
    },
    { plugins: stubPlugins, icons },
  );
  assert.ok(b.ok);
  assert.deepEqual(
    icons.calls.map((c) => c.icon),
    ["mdi-server", undefined, undefined, undefined, "https://icons.lan/x.png", undefined, "/icons/local.png", undefined],
  );
  assert.equal(icons.calls.length, 8, "resolve() is called for every tile");
  const cfg = projectOf(b as BuiltConfig);
  const t = allTiles(cfg);
  assert.deepEqual(t.find((x) => x.name === "B")!.icon, { kind: "letter", letter: "B" });
  assert.deepEqual(t.find((x) => x.name === "E")!.icon, { kind: "url", src: "https://icons.lan/x.png" });
  assert.equal((b as BuiltConfig).problems.filter((p) => p.code === "item.icon").length, 4);
});

test("projection: an icon service returning unsafe refs is sanitised (R3)", () => {
  const evil = {
    resolve: (icon: string | undefined, name: string) =>
      name === "A" ? { kind: "url" as const, src: "javascript:alert(1)" } : name === "B" ? { kind: "proxied" as const, src: "../../secret" } : { kind: "url" as const, src: "http://u:p@x.lan/i.png" },
  };
  const b = buildConfig({ services: "- G:\n    - A:\n    - B:\n    - C:\n", settings: null, secrets: null }, { plugins: stubPlugins, icons: evil });
  assert.ok(b.ok);
  const t = allTiles(projectOf(b as BuiltConfig));
  assert.deepEqual(t.map((x) => x.icon), [{ kind: "letter", letter: "A" }, { kind: "letter", letter: "B" }, { kind: "letter", letter: "C" }]);
});

test("validation: checks (siteMonitor, ping, both) and invalid values", () => {
  const b = ok(
    build(`- G:
    - A:
        siteMonitor: http://a.lan/
    - B:
        ping: b.lan
    - C:
        siteMonitor: https://c.lan/
        ping: 192.0.2.3
    - D:
        ping: "-oProxyCommand=evil"
    - E:
        siteMonitor: notaurl
    - F:
        ping: http://f.lan:8080/x
    - V6:
        ping: "[2001:db8::1]"
`),
  );
  const t = (n: string) => b.tiles.find((x) => x.name === n)!;
  assert.deepEqual(t("A").check, { kind: "http", url: "http://a.lan/" });
  assert.deepEqual(t("B").check, { kind: "ping", host: "b.lan" });
  assert.deepEqual(t("C").check, { kind: "http", url: "https://c.lan/", ping: "192.0.2.3" });
  assert.equal(t("D").check, undefined);
  assert.equal(t("E").check, undefined);
  assert.deepEqual(t("F").check, { kind: "ping", host: "f.lan" });
  assert.deepEqual(t("V6").check, { kind: "ping", host: "2001:db8::1" });
  assert.deepEqual(codes(b.problems).sort(), ["item.ping", "item.siteMonitor", "key.ignored"]);
  const pingNote = b.problems.find((p) => p.code === "key.ignored")!;
  assert.equal(pingNote.severity, "info");
  assert.equal(pingNote.tileId, t("C").id);
  assert.equal(pingNote.line, 8);
  const cfg = projectOf(b);
  assert.deepEqual(allTiles(cfg).map((x) => x.check), ["http", "ping", "http", "none", "none", "ping", "ping"]);
});

test("validation: widgets — unknown type, required keys, fields, unknown settings, multiple widgets", () => {
  const b = ok(
    build(`- G:
    - Prox:
        href: http://prox.lan/
        widget:
          type: proxmox
          url: http://prox.lan
          username: SENTINEL-UNSUP-USER-0001
    - Prox2:
        widget:
          type: proxmox
    - NoKey:
        widget:
          type: lidarr
          url: http://lidarr.lan
    - NoUrl:
        widget:
          type: sonarr
          key: abcdef
    - BadUrl:
        widget:
          type: sonarr
          url: file:///etc/passwd
          key: abcdef
    - Fields:
        widget:
          type: jellyfin
          url: http://jf.lan
          key: abcdef
          enableNowPlaying: false
          fields: ["songs", "bogus", "albums", "movies", "series", "episodes"]
    - Typo:
        widget:
          type: radarr
          url: http://radarr.lan
          key: abcdef
          enableQeue: true
    - Multi:
        widgets:
          - type: proxmox
          - type: sonarr
            url: http://s.lan
            key: abcdef
    - NoType:
        widget:
          url: http://x.lan
`),
  );
  const t = (n: string) => b.tiles.find((x) => x.name === n)!;
  assert.equal(t("Prox").widget?.supported, false);
  assert.deepEqual(t("Prox").widget?.cfg, { type: "proxmox" }, "unsupported widget block is not kept");
  assert.ok(b.secrets.includes("SENTINEL-UNSUP-USER-0001"), "secrets in unsupported widgets are still redacted from logs");
  assert.equal(b.problems.filter((p) => p.code === "widget.unsupported").length, 1, "unsupported type listed once");
  assert.equal(t("NoKey").widget?.configError, "The lidarr widget needs `key:`.");
  assert.equal(t("NoUrl").widget?.configError, "The sonarr widget needs `url:`.");
  assert.match(t("BadUrl").widget!.configError!, /isn't a valid http\(s\) URL/);
  assert.deepEqual(t("Fields").widget?.fields, ["songs", "albums", "movies", "series"]);
  assert.equal(t("Fields").widget?.nowPlaying, false);
  assert.ok(b.problems.some((p) => p.code === "widget.field" && /bogus/.test(p.message)));
  assert.ok(b.problems.some((p) => p.code === "widget.field" && /Only 4 fields/.test(p.message)));
  assert.ok(b.problems.some((p) => p.code === "widget.key.unknown" && p.message === 'Unknown setting "enableQeue" for the radarr widget.'));
  assert.equal(t("Multi").widget?.type, "sonarr", "first supported widget wins");
  assert.ok(b.problems.some((p) => p.code === "widget.multiple" && p.severity === "info"));
  assert.equal(t("NoType").widget, undefined);
  assert.ok(b.problems.some((p) => p.code === "widget.config" && p.message === "This widget needs `type:`."));
  const cfg = projectOf(b);
  const prox = allTiles(cfg).find((x) => x.name === "Prox")!;
  assert.deepEqual(prox.widget, { type: "proxmox", supported: false, hideErrors: false, fields: [] });
  const fields = allTiles(cfg).find((x) => x.name === "Fields")!;
  assert.deepEqual(fields.widget?.fields[0], { key: "songs", label: "Songs", format: "number" });
});

test("validation: truenas validate() and numeric-looking keys keep their source text", () => {
  const b = ok(
    build(`- G:
    - NAS:
        widget:
          type: truenas
          url: https://nas.lan
    - NAS2:
        widget:
          type: truenas
          url: https://nas.lan
          key: 0123456789
          tlsVerify: true
          hideErrors: true
`),
  );
  const t = (n: string) => b.tiles.find((x) => x.name === n)!;
  assert.match(t("NAS").widget!.configError!, /needs `key:` or `username:`/);
  assert.equal(t("NAS2").widget?.cfg.key, "0123456789");
  assert.equal(t("NAS2").widget?.tlsVerify, true);
  assert.equal(t("NAS2").widget?.hideErrors, true);
  assert.equal(t("NAS").widget?.tlsVerify, false, "default tlsVerify is false");
});

test("validation: nested groups render one level; deeper levels flatten into the second", () => {
  const b = ok(
    build(`- Top:
    - A:
        href: http://a.lan/
    - Sub:
        - B:
            href: http://b.lan/
        - Deeper:
            - C:
                href: http://c.lan/
`),
  );
  const cfg = projectOf(b);
  assert.equal(cfg.groups.length, 1);
  const top = cfg.groups[0]!;
  assert.deepEqual(top.tiles.map((t) => t.name), ["A"]);
  assert.equal(top.groups.length, 1);
  assert.equal(top.groups[0]!.name, "Sub");
  assert.deepEqual(top.groups[0]!.groups, []);
  assert.deepEqual(top.groups[0]!.tiles.map((t) => t.name), ["B", "C"]);
  assert.deepEqual(b.tiles.find((t) => t.name === "C")!.groupPath, ["Top", "Sub", "Deeper"]);
});

test("validation: tile ids are stable, unique for duplicates, and follow design §4.7", () => {
  const src = `- G:
    - A:
        href: http://a.lan/
    - A:
        href: http://a2.lan/
`;
  const b1 = ok(build(src));
  const b2 = ok(build(src.replace("a2.lan", "a3.lan")));
  assert.equal(b1.tiles[0]!.id, tileIdFor(["G"], "A", 0));
  assert.equal(b1.tiles[1]!.id, tileIdFor(["G"], "A", 1));
  assert.notEqual(b1.tiles[0]!.id, b1.tiles[1]!.id);
  assert.match(b1.tiles[0]!.id, /^[0-9a-f]{12}$/);
  assert.equal(b1.tiles[1]!.id, b2.tiles[1]!.id, "id survives an href change");
  assert.equal(b1.tiles[0]!.hash, b2.tiles[0]!.hash);
});

test("validation: hash changes when the check or widget changes", () => {
  const a = ok(build("- G:\n    - A:\n        siteMonitor: http://a.lan/\n"));
  const b = ok(build("- G:\n    - A:\n        siteMonitor: http://b.lan/\n"));
  assert.notEqual(a.tiles[0]!.hash, b.tiles[0]!.hash);
});

test("validation: malformed items are skipped with a problem; others still load", () => {
  const b = ok(
    build(`- G:
    - Plex:
      icon: plex.png
    - Good:
        href: http://good.lan/
    - "just a string"
    - "":
        href: http://x.lan/
- Bad: { a: 1 }
- 42
- Empty:
`),
  );
  assert.deepEqual(b.tiles.map((t) => t.name), ["Good"]);
  const c = codes(b.problems);
  assert.ok(c.includes("item.invalid"));
  assert.ok(c.includes("item.name"));
  assert.ok(c.includes("group.invalid"));
  const multi = b.problems.find((p) => p.code === "item.invalid" && /found 2 keys/.test(p.message))!;
  assert.equal(multi.line, 2);
  const cfg = projectOf(b);
  assert.deepEqual(cfg.groups.map((g) => g.name), ["G", "Empty"]);
});

test("validation: a bare service (no settings) is a valid tile", () => {
  const b = ok(build("- G:\n    - Router:\n"));
  assert.deepEqual(b.problems, []);
  const t = allTiles(projectOf(b))[0]!;
  assert.deepEqual(t, { id: t.id, name: "Router", check: "none", icon: { kind: "letter", letter: "R" } });
});

test("validation: YAML anchors and merge keys work", () => {
  const b = ok(
    build(`- G:
    - A:
        widget: &w
          type: sonarr
          url: http://s.lan
          key: abcdef
    - B:
        widget:
          <<: *w
          url: http://s2.lan
`),
  );
  assert.equal(b.tiles[1]!.widget?.cfg.url, "http://s2.lan");
  assert.equal(b.tiles[1]!.widget?.cfg.key, "abcdef");
  assert.equal(b.tiles[1]!.widget?.configError, undefined);
});

// ---------------------------------------------------------------------------
// Settings (design §4.3)
// ---------------------------------------------------------------------------

test("settings: our keys, layout order/columns/collapse, wrong types and ranges", () => {
  const b = ok(
    build(
      "- A:\n    - x:\n- B:\n    - y:\n- C:\n    - z:\n",
      `title: My Lab
hideNoCheck: true
tlsVerify: true
statusInterval: 5
widgetInterval: 60
hideErrors: yes
groupsInitiallyCollapsed: true
layout:
  C:
    columns: 3
    style: row
  A:
    initiallyCollapsed: false
    columns: 99
theme: dark
providers:
  openweathermap: SENTINEL-PROVIDER-0001
mysteryKey: 1
`,
    ),
  );
  assert.equal(b.settings.title, "My Lab");
  assert.equal(b.settings.hideNoCheck, true);
  assert.equal(b.settings.tlsVerify, true);
  assert.equal(b.settings.statusIntervalS, 10, "clamped to the minimum");
  assert.equal(b.settings.widgetIntervalS, 60);
  assert.equal(b.settings.hideErrors, false, "yes is a string in YAML 1.2, so rejected");
  const cfg = projectOf(b);
  assert.deepEqual(cfg.groups.map((g) => g.name), ["C", "A", "B"], "layout order first");
  assert.equal(cfg.groups[0]!.columns, 3);
  assert.equal(cfg.groups[1]!.columns, undefined);
  assert.deepEqual(cfg.groups.map((g) => g.collapsed), [true, false, true]);
  assert.deepEqual(cfg.settings, { hideNoCheck: true, groupsInitiallyCollapsed: true, disableCollapse: false, statusIntervalS: 10, widgetIntervalS: 60 });
  assert.ok(b.secrets.includes("SENTINEL-PROVIDER-0001"));
  assert.ok(!JSON.stringify(cfg).includes("SENTINEL-PROVIDER-0001"));
  const c = codes(b.problems);
  assert.ok(c.includes("settings.range"));
  assert.equal(c.filter((x) => x === "settings.type").length, 2, "hideErrors and columns");
  assert.ok(b.problems.some((p) => p.code === "key.unknown" && /mysteryKey/.test(p.message) && p.severity === "info"));
  assert.ok(b.problems.some((p) => p.code === "key.ignored" && p.file === "settings.yaml"));
});

test("settings: the widget interval default follows settings, plugin intervals win", () => {
  const b = ok(build("- G:\n    - P:\n        widget:\n          type: plex\n          url: http://p.lan\n          key: abcdef\n    - S:\n        widget:\n          type: sonarr\n          url: http://s.lan\n          key: abcdef\n", "widgetInterval: 45\n"));
  assert.equal(b.tiles[0]!.widget?.intervalS, 60);
  assert.equal(b.tiles[1]!.widget?.intervalS, 45);
  assert.equal(b.tiles[1]!.widget?.timeoutS, 10);
});

// ---------------------------------------------------------------------------
// Fatal errors and excerpts (design §4.8, UX §8)
// ---------------------------------------------------------------------------

test("fatal: tab indentation gives the C-27 message, file:line and a redacted excerpt", () => {
  const r = build("- Media:\n    - Plex:\n        key: SENTINEL-TAB-0001\n\t\thref: http://x\n");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.code, "yaml.parse");
  assert.equal(r.error.file, "services.yaml");
  assert.equal(r.error.line, 4);
  assert.equal(r.error.message, "Tabs aren't allowed in YAML. Use spaces.");
  assert.ok(r.error.excerpt);
  assert.equal(r.error.excerpt.markLine, 4);
  assert.ok(!JSON.stringify(r).includes("SENTINEL-TAB-0001"), "the key line is masked in the excerpt");
  assert.ok(r.error.excerpt.lines.includes("        key: ••••••"));
});

test("fatal: duplicate key names the key", () => {
  const r = build("- G:\n    - A:\n        href: http://a/\n        href: http://b/\n");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.message, '"href" appears twice in the same block.');
  assert.equal(r.error.line, 4);
});

test("fatal: wrong root shapes and a missing services.yaml", () => {
  for (const [services, settings, secrets, file] of [
    ["Media: []", null, null, "services.yaml"],
    ["- G: []", "- a", null, "settings.yaml"],
    ["- G: []", null, "- a", "secrets.yaml"],
    [null, null, null, "services.yaml"],
  ] as const) {
    const r = build(services, settings, secrets);
    assert.equal(r.ok, false, String(services));
    if (!r.ok) assert.equal(r.error.file, file);
  }
});

test("fatal: a broken secrets.yaml never shows its values in the excerpt", () => {
  const r = build("- G: []", null, "a: SENTINEL-SECFILE-0001\nb: [unclosed\nc: SENTINEL-SECFILE-0002\n");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.file, "secrets.yaml");
  assert.ok(!JSON.stringify(r).includes("SENTINEL-SECFILE"));
});

test("fatal: messages and excerpts are redacted with secrets.yaml values", () => {
  const r = build("- G:\n    - A:\n        description: SENTINEL-DESC-0001-long\n      bad: [\n", null, "x: SENTINEL-DESC-0001-long\n");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.secrets.includes("SENTINEL-DESC-0001-long"), "known for log redaction");
  assert.ok(!JSON.stringify(r.problems).includes("SENTINEL-DESC-0001-long"));
  const r2 = build("- G:\n    - A:\n        description: SENTINEL-DESC-0001-long\n        bad: [\n", null, "x: SENTINEL-DESC-0001-long\n");
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.ok(r2.error.excerpt!.lines.some((l) => l.includes("description: ••••")), JSON.stringify(r2.error));
    assert.ok(!JSON.stringify(r2.problems).includes("SENTINEL-DESC-0001-long"));
  }
});

test("empty services.yaml (or comments only) is zero services, not an error", () => {
  for (const s of ["", "# nothing\n", "---\n", "[]\n"]) {
    const b = ok(build(s));
    assert.equal(b.counts.services, 0);
    assert.deepEqual(b.groups, []);
  }
});

test("ignored Homepage files are listed once as info", () => {
  const b = ok(build("- G: []", null, null, ["bookmarks.yaml", "custom.css"]));
  assert.deepEqual(
    b.problems.map((p) => [p.severity, p.code, p.file]),
    [
      ["info", "file.ignored", "bookmarks.yaml"],
      ["info", "file.ignored", "custom.css"],
    ],
  );
});

test("excerpts mask secret-position values even when the key name looks harmless", () => {
  const b = ok(
    build(`- G:
    - A:
        widget:
          type: sonarr
          url: http://s.lan
          key: !secret k
          headers:
            X-Custom: SENTINEL-HDR-0001
          bogus: 1
`, null, "k: SENTINEL-TAGGED-0001\n"),
  );
  const p = b.problems.find((x) => x.code === "widget.key.unknown")!;
  assert.equal(p.line, 9);
  assert.deepEqual(p.excerpt?.lines, ["            X-Custom: ••••••", "          bogus: 1"]);
});

test("a recursive alias bomb is refused, not expanded", () => {
  const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
  for (let i = 1; i < 10; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]`);
  const r = build("- G: []", null, lines.join("\n") + "\n");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error.message, /too many entries/);
});
