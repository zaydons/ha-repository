import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countWhere,
  expectArray,
  expectRecord,
  isRecord,
  parseClock,
  parseSize,
  pickFields,
  round,
  sumOf,
  toNumber,
  toText,
  wants,
} from "../../src/widgets/lib/format.ts";

test("toNumber", () => {
  assert.equal(toNumber(3), 3);
  assert.equal(toNumber(" 4.5 "), 4.5);
  assert.equal(toNumber(""), null);
  assert.equal(toNumber("abc"), null);
  assert.equal(toNumber(NaN), null);
  assert.equal(toNumber(Infinity), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber(true), null);
});

test("toText trims, caps and rejects non-strings", () => {
  assert.equal(toText("  hi "), "hi");
  assert.equal(toText(""), null);
  assert.equal(toText(5), "5");
  assert.equal(toText({}), null);
  assert.equal(toText("x".repeat(500))?.length, 200);
});

test("round", () => {
  assert.equal(round(1.23456, 2), 1.23);
  assert.equal(round(2.5), 3);
  assert.equal(round(null, 2), null);
});

test("expectRecord / expectArray / isRecord", () => {
  assert.deepEqual(expectRecord({ a: 1 }, "x"), { a: 1 });
  assert.throws(() => expectRecord([], "x"), { kind: "bad_response" });
  assert.throws(() => expectRecord(null, "x"), { kind: "bad_response" });
  assert.deepEqual(expectArray([1], "x"), [1]);
  assert.throws(() => expectArray({}, "x"), { kind: "bad_response" });
  assert.equal(isRecord("s"), false);
});

test("sumOf: missing values count 0; null when no item has the key", () => {
  assert.equal(sumOf([{ a: 1 }, { a: "2" }, { b: 3 }, null], "a"), 3);
  assert.equal(sumOf([{ b: 1 }], "a"), null);
  assert.equal(sumOf([], "a"), 0);
  assert.equal(sumOf([], "a", true), null);
});

test("countWhere", () => {
  assert.equal(countWhere([{ x: true }, { x: false }, 1, null], (i) => i.x === true), 1);
});

test("parseSize: base 1024 units", () => {
  assert.equal(parseSize("1.5 M"), 1.5 * 1024 * 1024);
  assert.equal(parseSize("512K"), 512 * 1024);
  assert.equal(parseSize("3 GB"), 3 * 1024 ** 3);
  assert.equal(parseSize("2 MiB/s"), 2 * 1024 ** 2);
  assert.equal(parseSize("800 B"), 800);
  assert.equal(parseSize("0"), 0);
  assert.equal(parseSize(42), 42);
  assert.equal(parseSize("1 X"), null);
  assert.equal(parseSize("fast"), null);
  assert.equal(parseSize(null), null);
  assert.equal(parseSize("1 k", 1000), 1000);
});

test("parseClock", () => {
  assert.equal(parseClock("0:01:05"), 65);
  assert.equal(parseClock("1:00:00:00"), 86400);
  assert.equal(parseClock("10:00"), 600);
  assert.equal(parseClock("unknown"), null);
  assert.equal(parseClock("1:-1"), null);
  assert.equal(parseClock(5), null);
});

test("pickFields and wants", () => {
  assert.deepEqual(pickFields({ a: 1, b: null, c: 3 }, ["c", "a", "z"]), { c: 3, a: 1, z: null });
  assert.equal(wants(["a", "b"], "x", "b"), true);
  assert.equal(wants(["a"], "x"), false);
});
