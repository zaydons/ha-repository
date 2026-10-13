import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPathFor, optionsFilePath, parseOptions, readOptions, slugFromHostname, slugFromSupervisorInfo, DEFAULT_OPTIONS } from "../../src/options.ts";
import type { Logger } from "../../src/types.ts";

const warnings: string[] = [];
const log: Logger = { debug() {}, info() {}, warn: (m) => void warnings.push(m), error() {}, child: () => log };

test("parseOptions: valid, invalid and missing values", () => {
  assert.deepEqual(parseOptions({ theme: "dark", log_level: "debug" }), { options: { theme: "dark", log_level: "debug" }, invalid: [] });
  assert.deepEqual(parseOptions({ theme: "neon", log_level: 3 }), { options: { ...DEFAULT_OPTIONS }, invalid: ["theme", "log_level"] });
  assert.deepEqual(parseOptions({}).options, DEFAULT_OPTIONS);
  assert.deepEqual(parseOptions([]).invalid, ["(not an object)"]);
});

test("readOptions: missing file and bad JSON fall back to defaults", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hl-opt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await readOptions(join(dir, "missing.json"), log), DEFAULT_OPTIONS);
  await writeFile(join(dir, "bad.json"), "{not json");
  assert.deepEqual(await readOptions(join(dir, "bad.json"), log), DEFAULT_OPTIONS);
  await writeFile(join(dir, "ok.json"), JSON.stringify({ theme: "light", log_level: "warning" }));
  assert.deepEqual(await readOptions(join(dir, "ok.json"), log), { theme: "light", log_level: "warning" });
});

test("config path display from slug sources", () => {
  assert.equal(configPathFor("a1b2c3d4_homelab"), "/addon_configs/a1b2c3d4_homelab/");
  assert.equal(configPathFor("local_homelab_dev"), "/addon_configs/local_homelab_dev/");
  assert.equal(configPathFor("../etc"), "/addon_configs/");
  assert.equal(configPathFor(null), "/addon_configs/");
  assert.equal(slugFromHostname("a1b2c3d4-homelab"), "a1b2c3d4_homelab");
  assert.equal(slugFromHostname("3f2a9c1e7b44"), null);
  // F-1: every "-" maps back to "_" (slugs can't contain "-").
  assert.equal(slugFromHostname("local-homelab-dev"), "local_homelab_dev");
  assert.equal(slugFromHostname("a1b2c3d4-homelab-dev"), "a1b2c3d4_homelab_dev");
  assert.equal(configPathFor(slugFromHostname("local-homelab-dev")), "/addon_configs/local_homelab_dev/");
  for (const bad of ["-local", "local-", "local--x", "Local-x", "local_x", "a.b-c", ""]) assert.equal(slugFromHostname(bad), null, bad);
  assert.equal(slugFromHostname(`a-${"b".repeat(70)}`), null);
  assert.equal(slugFromSupervisorInfo({ result: "ok", data: { slug: "local_homelab_dev" } }), "local_homelab_dev");
  assert.equal(slugFromSupervisorInfo({ data: { slug: "Bad Slug" } }), null);
  assert.equal(slugFromSupervisorInfo(null), null);
});

test("optionsFilePath: entrypoint copy when set and absolute, else <dataDir>/options.json", () => {
  assert.equal(optionsFilePath({ HL_OPTIONS_FILE: "/run/homelab/options.json" }, "/data"), "/run/homelab/options.json");
  assert.equal(optionsFilePath({}, "/data"), "/data/options.json");
  assert.equal(optionsFilePath({ HL_OPTIONS_FILE: "" }, "/data"), "/data/options.json");
  assert.equal(optionsFilePath({ HL_OPTIONS_FILE: "relative.json" }, "/tmp/d"), "/tmp/d/options.json");
});

test("readOptions: an unreadable file warns with the code and falls back to defaults", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can read any file");
  const dir = await mkdtemp(join(tmpdir(), "hl-opt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = join(dir, "options.json");
  await writeFile(f, JSON.stringify({ theme: "dark" }), { mode: 0o000 });
  warnings.length = 0;
  assert.deepEqual(await readOptions(f, log), DEFAULT_OPTIONS);
  assert.ok(warnings.some((w) => w.includes("Can't read app options")));
});
