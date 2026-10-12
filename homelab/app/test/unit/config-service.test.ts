import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createConfigService, MAX_CONFIG_BYTES } from "../../src/config/index.ts";
import type { ConfigServiceOptions } from "../../src/config/index.ts";
import { createLogger, setLogLevel, setLogSecrets, setLogSink } from "../../src/log.ts";
import type { BootContext, NormalisedConfig } from "../../src/types.ts";
import { stubIcons, stubPlugins } from "../support/stub-plugins.ts";

const SAMPLE = fileURLToPath(new URL("../../sample/", import.meta.url));

const GOOD = `- Apps:
    - Sonarr:
        href: http://sonarr.lan:8989/
        siteMonitor: http://sonarr.lan:8989/
        widget:
          type: sonarr
          url: http://sonarr.lan:8989
          key: !secret sonarr_key
`;
const SECRETS = "sonarr_key: SENTINEL-SVC-KEY-0001\n";
const BROKEN = `- Apps:
    - Sonarr:
        href: http://sonarr.lan:8989/
       key: SENTINEL-SVC-INLINE-0002
        bad: [
`;

async function setup(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hl-cfg-"));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  await mkdir(configDir);
  await mkdir(dataDir);
  for (const [n, t] of Object.entries(files)) await writeFile(join(configDir, n), t);
  const lines: string[] = [];
  setLogSink((_lvl, line) => lines.push(line));
  setLogLevel("debug");
  const ctx: BootContext = {
    options: { theme: "auto", log_level: "debug" },
    paths: { configDir, dataDir, sampleDir: SAMPLE, webDir: "/nonexistent" },
    configPathDisplay: "/addon_configs/test_homelab/",
    log: createLogger(),
  };
  const services: ReturnType<typeof createConfigService>[] = [];
  const make = (opts: ConfigServiceOptions = { watch: false }) => {
    const s = createConfigService(ctx, stubPlugins, stubIcons(), opts);
    services.push(s);
    return s;
  };
  const cleanup = async () => {
    for (const s of services) await s.stop();
    setLogSink(null);
    setLogLevel("info");
    setLogSecrets([]);
    await rm(root, { recursive: true, force: true });
  };
  return { root, configDir, dataDir, ctx, lines, make, cleanup };
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

test("service: loads, projects, registers log secrets and persists last-good (0600)", async (t) => {
  const env = await setup({ "services.yaml": GOOD, "secrets.yaml": SECRETS });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();
  const pub = svc.getPublic();
  assert.equal(pub.error, undefined);
  assert.equal(pub.usingLastGood, false);
  assert.equal(pub.sampleInUse, false);
  assert.equal(pub.configPath, "/addon_configs/test_homelab/");
  assert.equal(pub.groups[0]!.tiles[0]!.name, "Sonarr");
  assert.ok(!JSON.stringify(pub).includes("SENTINEL"));
  const n = svc.getNormalised()!;
  assert.equal(n.rev, pub.rev);
  assert.equal(n.tiles[0]!.widget?.cfg.key, "SENTINEL-SVC-KEY-0001");
  assert.ok(n.secrets.includes("SENTINEL-SVC-KEY-0001"));

  env.ctx.log.info("probe SENTINEL-SVC-KEY-0001");
  assert.ok(env.lines.some((l) => l.includes("Config loaded: 1 groups, 1 services, 1 widgets (0 warnings)")));
  assert.ok(!env.lines.join("\n").includes("SENTINEL-SVC-KEY-0001"), "log lines are redacted");

  const lgPath = join(env.dataDir, "last-good.json");
  const st = await stat(lgPath);
  assert.equal(st.mode & 0o777, 0o600);
  const lg = JSON.parse(await readFile(lgPath, "utf8"));
  assert.equal(lg.version, 1);
  assert.equal(lg.files.services, GOOD);
});

test("service: a broken edit keeps the last good tiles, shows the error, and survives a restart (AC8)", async (t) => {
  const env = await setup({ "services.yaml": GOOD, "secrets.yaml": SECRETS });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();
  const rev1 = svc.getPublic().rev;
  const loadedAt1 = svc.getPublic().loadedAt;
  let changes = 0;
  svc.onChange(() => changes++);

  await writeFile(join(env.configDir, "services.yaml"), BROKEN);
  await svc.reload();
  const pub = svc.getPublic();
  assert.ok(pub.rev > rev1, "rev bumps on error-state change");
  assert.equal(pub.usingLastGood, true);
  assert.equal(pub.error?.file, "services.yaml");
  assert.equal(pub.error?.code, "yaml.parse");
  assert.ok(pub.error?.line);
  assert.ok(pub.error?.excerpt);
  assert.equal(pub.problems[0]!.code, "yaml.parse", "fatal error first in problems");
  assert.equal(pub.groups[0]!.tiles[0]!.name, "Sonarr", "last good tiles still shown");
  assert.equal(pub.loadedAt, loadedAt1);
  assert.equal(changes, 0, "normalised config unchanged: no onChange");
  assert.ok(!JSON.stringify(pub).includes("SENTINEL-SVC-INLINE-0002"), "excerpt redacts the inline key");
  assert.ok(env.lines.some((l) => l.includes("Config error: services.yaml:") && l.includes("showing the last working config")));

  // Restart with the broken file still in place: last-good.json is used.
  await svc.stop();
  const svc2 = env.make();
  await svc2.start();
  const pub2 = svc2.getPublic();
  assert.equal(pub2.usingLastGood, true);
  assert.equal(pub2.error?.code, "yaml.parse");
  assert.equal(pub2.groups[0]!.tiles[0]!.name, "Sonarr");
  assert.equal(svc2.getNormalised()?.tiles[0]!.widget?.cfg.key, "SENTINEL-SVC-KEY-0001");

  // Fixing the file clears the error.
  await writeFile(join(env.configDir, "services.yaml"), GOOD.replace("Sonarr:", "Sonarr 4:"));
  await svc2.reload();
  const pub3 = svc2.getPublic();
  assert.equal(pub3.error, undefined);
  assert.equal(pub3.usingLastGood, false);
  assert.equal(pub3.groups[0]!.tiles[0]!.name, "Sonarr 4");
});

test("service: first-ever load broken and no last-good gives the full-page error state", async (t) => {
  const env = await setup({ "services.yaml": BROKEN });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();
  const pub = svc.getPublic();
  assert.equal(pub.usingLastGood, false);
  assert.ok(pub.error);
  assert.deepEqual(pub.groups, []);
  assert.equal(pub.title, "Homelab");
  assert.equal(svc.getNormalised(), null);
});

test("service: a corrupt last-good.json is ignored with a warning", async (t) => {
  const env = await setup({ "services.yaml": BROKEN });
  t.after(env.cleanup);
  await writeFile(join(env.dataDir, "last-good.json"), "{not json");
  const svc = env.make();
  await svc.start();
  assert.deepEqual(svc.getPublic().groups, []);
  assert.ok(env.lines.some((l) => l.includes("Ignoring an unreadable last-good.json")));
});

test("service: rev and onChange only move when something changed", async (t) => {
  const env = await setup({ "services.yaml": GOOD, "secrets.yaml": SECRETS });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();
  const got: NormalisedConfig[] = [];
  svc.onChange((c) => got.push(c));
  const rev = svc.getPublic().rev;
  await svc.reload();
  assert.equal(svc.getPublic().rev, rev, "no change, no rev bump");
  assert.equal(got.length, 0);

  // A description change: public changes, normalised (checks/widgets) does not.
  await writeFile(join(env.configDir, "services.yaml"), GOOD.replace("siteMonitor", "description: TV\n        siteMonitor"));
  await svc.reload();
  assert.equal(svc.getPublic().rev, rev + 1);
  assert.equal(got.length, 0);

  // A widget change: both change.
  await writeFile(join(env.configDir, "secrets.yaml"), "sonarr_key: SENTINEL-SVC-KEY-0003\n");
  await svc.reload();
  assert.equal(got.length, 1);
  assert.equal(got[0]!.tiles[0]!.widget?.cfg.key, "SENTINEL-SVC-KEY-0003");
  assert.equal(got[0]!.rev, svc.getPublic().rev);
});

test("service: sampleInUse follows the shipped sample's hash", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  await cp(join(SAMPLE, "services.yaml"), join(env.configDir, "services.yaml"));
  const svc = env.make();
  await svc.start();
  assert.equal(svc.getPublic().sampleInUse, true);
  await writeFile(join(env.configDir, "services.yaml"), GOOD);
  await svc.reload();
  assert.equal(svc.getPublic().sampleInUse, false);
});

test("service: hot reload via the stat poll (no fs.watch) within the poll interval", async (t) => {
  const env = await setup({ "services.yaml": GOOD, "secrets.yaml": SECRETS });
  t.after(env.cleanup);
  const svc = env.make({ watch: true, useFsWatch: false, pollMs: 50, debounceMs: 10 });
  await svc.start();
  const rev = svc.getPublic().rev;
  await writeFile(join(env.configDir, "services.yaml"), GOOD.replace("Sonarr:", "Sonarr Polled:"));
  await waitFor(() => svc.getPublic().rev > rev);
  assert.equal(svc.getPublic().groups[0]!.tiles[0]!.name, "Sonarr Polled");
  // secrets.yaml is watched too.
  const rev2 = svc.getPublic().rev;
  await rm(join(env.configDir, "secrets.yaml"));
  await waitFor(() => svc.getPublic().rev > rev2);
  assert.ok(svc.getPublic().problems.some((p) => p.code === "secret.missing"));
});

test("service: hot reload via fs.watch (default watcher)", async (t) => {
  const env = await setup({ "services.yaml": GOOD, "secrets.yaml": SECRETS });
  t.after(env.cleanup);
  const svc = env.make({ watch: true, pollMs: 60_000, debounceMs: 20 });
  await svc.start();
  const rev = svc.getPublic().rev;
  await writeFile(join(env.configDir, "services.yaml"), GOOD.replace("Sonarr:", "Sonarr Watched:"));
  await waitFor(() => svc.getPublic().rev > rev);
  assert.equal(svc.getPublic().groups[0]!.tiles[0]!.name, "Sonarr Watched");
});

test("service: unreadable, oversized and missing files are fatal with a clear message", async (t) => {
  const env = await setup({ "services.yaml": GOOD });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();

  await writeFile(join(env.configDir, "settings.yaml"), "#".repeat(MAX_CONFIG_BYTES + 1));
  await svc.reload();
  assert.equal(svc.getPublic().error?.code, "file.read");
  assert.match(svc.getPublic().error!.message, /larger than 1 MB/);
  await rm(join(env.configDir, "settings.yaml"));

  if (process.getuid?.() !== 0) {
    await chmod(join(env.configDir, "services.yaml"), 0o000);
    await svc.reload();
    assert.match(svc.getPublic().error!.message, /permission denied/);
    await chmod(join(env.configDir, "services.yaml"), 0o644);
  }

  await rm(join(env.configDir, "services.yaml"));
  await svc.reload();
  assert.equal(svc.getPublic().error?.code, "file.missing");
  assert.equal(svc.getPublic().usingLastGood, true);
});

test("service: ignored Homepage files present in the folder are listed", async (t) => {
  const env = await setup({ "services.yaml": GOOD, "secrets.yaml": SECRETS, "bookmarks.yaml": "[]", "docker.yaml": "{}" });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();
  const ignored = svc.getPublic().problems.filter((p) => p.code === "file.ignored").map((p) => p.file);
  assert.deepEqual(ignored.sort(), ["bookmarks.yaml", "docker.yaml"]);
});

// ---------------------------------------------------------------------------
// Review B1: fatal excerpts must never carry a secret (AC9), through getPublic()
// ---------------------------------------------------------------------------

const B1_CASES: [string, string][] = [
  ["flow map", `- Apps:\n    - Sonarr:\n        widget: {type: sonarr, url: "http://a", key: SENTINELKEY1}\n      bad: [\n`],
  ["JSON style", `- Apps:\n    - Sonarr:\n        widget: {"type": "sonarr", "key": "SENTINELKEY1"}\n      bad: [\n`],
  ["multi-line plain value", `- Apps:\n    - Sonarr:\n        widget:\n          key:\n            SENTINELKEY1\n         bad: x\n`],
  ["value on the error line", `- Apps:\n    - Sonarr:\n        widget:\n         token: SENTINELKEY1\n          bad: [\n`],
  ["block scalar", `- Apps:\n    - A:\n        description: |\n          SENTINELKEY1\n          more: SENTINELKEY1\n      bad: [\n`],
  ["multi-line quoted", `- Apps:\n    - A:\n        description: "first\n          x: SENTINELKEY1"\n      bad: [\n`],
  ["harmless key", `- Apps:\n    - A:\n        note: SENTINELKEY1\n      bad: [\n`],
  ["comment", `- Apps:\n    - A:\n        # key: SENTINELKEY1\n\t\thref: x\n`],
  ["tab line", `- Apps:\n    - A:\n\t\tkey: SENTINELKEY1\n`],
];

for (const [name, text] of B1_CASES) {
  test(`B1: fatal excerpt never leaks an inline secret (${name})`, async (t) => {
    const env = await setup({ "services.yaml": text });
    t.after(env.cleanup);
    const svc = env.make();
    await svc.start();
    const pub = svc.getPublic();
    assert.ok(pub.error, `expected a fatal error for ${name}`);
    assert.ok(pub.error.excerpt, "the excerpt is still shown");
    const json = JSON.stringify(pub);
    assert.ok(!json.includes("SENTINELKEY1"), `${name}: ${JSON.stringify(pub.error.excerpt)}`);
    assert.ok(!env.lines.join("\n").includes("SENTINELKEY1"));
  });
}

test("B1: fatal excerpts keep structure (indentation and key names) for fixing", async (t) => {
  const env = await setup({ "services.yaml": "- Media:\n    - Plex:\n        href: http://plex.lan/\n       icon: plex.png\n" });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();
  const ex = svc.getPublic().error!.excerpt!;
  for (const l of ex.lines) assert.match(l, /^\s*(?:- )?(?:[A-Za-z]+:(?: ••••••)?|••••••)?$/, l);
  assert.ok(ex.lines.some((l) => l.includes("href: ••••••")));
});

test("B1: secrets from the last good config are redacted from a later fatal excerpt", async (t) => {
  const env = await setup({ "services.yaml": GOOD.replace("!secret sonarr_key", "LASTGOODKEY-0001"), "secrets.yaml": SECRETS });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();
  // Same key, now on an unparseable line in an unusual position.
  await writeFile(join(env.configDir, "services.yaml"), "- Apps:\n    - X: [LASTGOODKEY-0001\n");
  await svc.reload();
  const pub = svc.getPublic();
  assert.ok(pub.error);
  assert.ok(!JSON.stringify(pub).includes("LASTGOODKEY-0001"));
});

test("B1 (parsed path): an inline secret in a flow map is masked in warning excerpts", async (t) => {
  const env = await setup({
    "services.yaml": `- Apps:\n    - A:\n        widget: {type: sonarr, url: "http://a.lan", key: SENTINELKEY2, bogus: 1}\n        typo: 1\n    - B:\n        apikey:\n          SENTINELKEY3\n        typo2: 1\n`,
  });
  t.after(env.cleanup);
  const svc = env.make();
  await svc.start();
  const pub = svc.getPublic();
  assert.equal(pub.error, undefined);
  assert.ok(pub.problems.some((p) => p.excerpt));
  const json = JSON.stringify(pub);
  assert.ok(!json.includes("SENTINELKEY2"), json);
  assert.ok(!json.includes("SENTINELKEY3"), json);
});

// ---------------------------------------------------------------------------
// Review N2: a ca.pem change fires onChange
// ---------------------------------------------------------------------------

test("N2: a ca.pem-only change fires onChange (reload and the watcher)", async (t) => {
  const env = await setup({ "services.yaml": GOOD, "secrets.yaml": SECRETS });
  t.after(env.cleanup);
  const svc = env.make({ watch: true, useFsWatch: false, pollMs: 50, debounceMs: 10 });
  await svc.start();
  const got: NormalisedConfig[] = [];
  svc.onChange((c) => got.push(c));
  await writeFile(join(env.configDir, "ca.pem"), "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  await waitFor(() => got.length === 1);
  assert.equal(got[0]!.tiles[0]!.name, "Sonarr");
  await svc.reload();
  assert.equal(got.length, 1, "no change, no event");
  await rm(join(env.configDir, "ca.pem"));
  await waitFor(() => got.length === 2);
});
