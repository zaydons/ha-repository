import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPathFor, parseOptions, readOptions, slugFromHostname, slugFromSupervisorInfo, DEFAULT_OPTIONS } from "../../src/options.ts";
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
  assert.equal(slugFromSupervisorInfo({ result: "ok", data: { slug: "local_homelab_dev" } }), "local_homelab_dev");
  assert.equal(slugFromSupervisorInfo({ data: { slug: "Bad Slug" } }), null);
  assert.equal(slugFromSupervisorInfo(null), null);
});
