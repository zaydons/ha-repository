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

test("F-2: large numbers compact to 3 significant digits", () => {
  assert.equal(formatNumber(9_876, L), "9,876");
  assert.equal(formatNumber(10_000, L), "10K");
  assert.equal(formatNumber(412_345, L), "412K");
  assert.equal(formatNumber(99_999, L), "100K");
  assert.equal(formatNumber(1_047_552, L), "1.05M");
  assert.equal(formatNumber(-41_234, L), "-41.2K");
});

test("F-2: bytes never show a 4-digit number; they move to the next unit at 1000", () => {
  assert.equal(formatBytes(999.4, L), "999 B");
  assert.equal(formatBytes(999.6, L), "1 kB");
  assert.equal(formatBytes(999.6 * 1024 ** 2, L), "1 GB", "rounding up to 1000 also moves up");
  assert.equal(formatBytes(1023 * 1024 ** 2, L), "1 GB");
  assert.equal(formatBytes(58.2 * 1024 ** 4, L), "58.2 TB");
  assert.equal(formatBytes(512 * 1024 ** 3, L), "512 GB");
  assert.equal(formatBytes(2 * 1024 ** 6, L), "2,048 PB", "the top unit can't move up");
});

test("F-2: durations keep the two most significant units, years from 365 days", () => {
  assert.equal(formatDuration(45 * 86400 + 12 * 3600 + 59 * 60, L), "45d 12h");
  assert.equal(formatDuration(365 * 86400, L), "1y");
  assert.equal(formatDuration(400 * 86400 + 23 * 3600, L), "1y 35d");
  assert.equal(formatDuration(800 * 86400, L), "2y 70d");
});

test("F-2: worst-case stat values stay short enough for a 4-column tile", () => {
  const worst = [
    formatValue(99_999_999, "number", L),
    formatValue(9_999.99, "number", L),
    formatValue(999.4 * 1024 ** 5, "bytes", L),
    formatValue(99.9 * 1024 ** 3, "bytes", L),
    formatValue(99 * 86400 + 23 * 3600, "duration", L),
    formatValue(9_999 * 86400, "duration", L),
    formatValue(23 * 3600 + 59 * 60, "duration", L),
    formatValue(99.95, "percent", L),
  ];
  for (const v of worst) assert.ok(v.length <= 8, `"${v}" is ${v.length} characters`);
  assert.ok(formatValue(999.4 * 1024 ** 2, "byterate", L).length <= 9);
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
