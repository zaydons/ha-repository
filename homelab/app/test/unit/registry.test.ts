import { test } from "node:test";
import assert from "node:assert/strict";
import { plugins, findPlugin } from "../../src/widgets/index.ts";

test("registry: arr plugins registered and found by type", () => {
  for (const t of ["sonarr", "radarr", "lidarr", "prowlarr"]) assert.equal(findPlugin(t)?.type, t);
  assert.equal(findPlugin("nope"), undefined);
});

test("registry: every plugin is internally consistent", () => {
  const types = new Set<string>();
  for (const p of plugins) {
    assert.ok(!types.has(p.type), `duplicate type ${p.type}`);
    types.add(p.type);
    const keys = p.fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${p.type}: duplicate field`);
    for (const f of p.fields) assert.ok(f.label.length > 0, `${p.type}.${f.key}: empty label`);
    assert.ok(p.defaultFields.length > 0 && p.defaultFields.length <= 4, `${p.type}: 1..4 default fields`);
    for (const d of p.defaultFields) assert.ok(keys.includes(d), `${p.type}: default ${d} not in fields`);
    const known = [...p.configKeys.required, ...p.configKeys.optional];
    for (const s of p.configKeys.secret) assert.ok(known.includes(s), `${p.type}: secret ${s} not a config key`);
    if (p.intervalS !== undefined) assert.ok(p.intervalS >= 10);
    if (p.timeoutS !== undefined) assert.ok(p.timeoutS > 0);
  }
});
