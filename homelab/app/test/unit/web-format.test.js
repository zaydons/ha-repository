// Frontend formatting (web/format.js). Locale pinned to "en" for stable output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DASH, clampPct, formatBytes, formatDuration, formatNumber, formatValue, isMissing, relativeTime } from "../../web/format.js";

const L = "en";

test("numbers: plain below 10k, compact above, 2 decimals max", () => {
  assert.equal(formatNumber(1534, L), "1,534");
  assert.equal(formatNumber(0.4234, L), "0.42");
  assert.equal(formatNumber(41_234, L), "41.2K");
});

test("bytes and byterate use base 1024 with unit labels", () => {
  assert.equal(formatBytes(512, L), "512 B");
  assert.equal(formatBytes(0, L, true), "0 B/s");
  assert.equal(formatBytes(6.1 * 1024 ** 3, L), "6.1 GB");
  assert.equal(formatValue(12_582_912, "byterate", L), "12 MB/s");
});

test("durations are short and drop zero parts", () => {
  assert.equal(formatDuration(2_880_000, L), "33d 8h");
  assert.equal(formatDuration(3 * 3600, L), "3h");
  assert.equal(formatDuration(3 * 3600 + 20 * 60, L), "3h 20m");
  assert.equal(formatDuration(59, L), "59s");
  assert.equal(formatDuration(-5, L), "0s");
});

test("formatValue: percent, text, strings pass through, missing becomes a dash", () => {
  assert.equal(formatValue(14.8, "percent", L), "14.8%");
  assert.equal(formatValue(42, "text", L), "42");
  assert.equal(formatValue("0:42:10", "number", L), "0:42:10");
  for (const v of [null, undefined, NaN, Infinity, "", { a: 1 }]) assert.equal(formatValue(v, "number", L), DASH);
});

test("isMissing and clampPct", () => {
  assert.equal(isMissing(null), true);
  assert.equal(isMissing(0), false);
  assert.equal(isMissing(NaN), true);
  assert.equal(clampPct(42.6), 43);
  assert.equal(clampPct(-3), 0);
  assert.equal(clampPct(250), 100);
  assert.equal(clampPct("50"), null);
  assert.equal(clampPct(undefined), null);
});

test("relative time: just now under 10 s, then narrow units", () => {
  assert.equal(relativeTime(3000, L), "just now");
  assert.equal(relativeTime(-5000, L), "just now");
  assert.equal(relativeTime(12_000, L), "12s ago");
  assert.equal(relativeTime(125_000, L), "2m ago");
  assert.equal(relativeTime(3 * 3600_000, L), "3h ago");
  assert.equal(relativeTime(4 * 86400_000, L), "4d ago");
});
