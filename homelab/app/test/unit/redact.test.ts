import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, REDACTED } from "../../src/redact.ts";
import { createLogger, setLogLevel, setLogSecrets, setLogSink } from "../../src/log.ts";

const SECRET = "FAKE-sentinel-key-0001";

test("redact: replaces every occurrence of a secret", () => {
  assert.equal(redact(`a ${SECRET} b ${SECRET}`, [SECRET]), `a ${REDACTED} b ${REDACTED}`);
});

test("redact: URL-encoded and form-encoded forms are redacted", () => {
  const s = "p@ss w/rd&x=1";
  const out = redact(`u=${encodeURIComponent(s)} f=${new URLSearchParams({ x: s }).toString()} raw=${s}`, [s]);
  assert.ok(!out.includes(encodeURIComponent(s)));
  assert.ok(!out.includes("p%40ss+w%2Frd"));
  assert.ok(!out.includes(s));
});

test("redact: longer secrets win over secrets they contain", () => {
  assert.equal(redact("abcdef", ["abc", "abcdef"]), REDACTED);
});

test("redact: credential query parameters are redacted without a known secret", () => {
  const out = redact("GET http://sab.lan:8080/api?mode=queue&apikey=zzz999&output=json", []);
  assert.equal(out, `GET http://sab.lan:8080/api?mode=queue&apikey=${REDACTED}&output=json`);
  assert.equal(redact("/x?X-Plex-Token=abc123", []), `/x?X-Plex-Token=${REDACTED}`);
  assert.equal(redact("/x?API_KEY=abc&token=t1&key=k", []), `/x?API_KEY=${REDACTED}&token=${REDACTED}&key=${REDACTED}`);
  // Similar names are left alone.
  assert.equal(redact("/x?monkey=1&keyboard=2", []), "/x?monkey=1&keyboard=2");
});

test("redact: URL userinfo and auth headers are redacted", () => {
  assert.equal(redact("http://admin:hunter2@nas.lan/", []), `http://${REDACTED}@nas.lan/`);
  assert.equal(redact("Authorization: Bearer abc.def-123", []), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redact('MediaBrowser Token="abc123"', []), `MediaBrowser Token="${REDACTED}"`);
});

test("redact: ignores too-short, empty and non-string secrets", () => {
  assert.equal(redact("a 1 b xy c", ["", "1", "xy", undefined as unknown as string]), "a 1 b xy c");
});

test("redact: empty input and no secrets are no-ops", () => {
  assert.equal(redact("", [SECRET]), "");
  assert.equal(redact("nothing here"), "nothing here");
});

test("redact: regex metacharacters in secrets are literal", () => {
  assert.equal(redact("x a.*b y aXXb", ["a.*b"]), `x ${REDACTED} y aXXb`);
});

test("logger: lines are redacted, single-line, and level-filtered", (t) => {
  const lines: string[] = [];
  setLogSink((_lvl, line) => lines.push(line));
  t.after(() => {
    setLogSink(null);
    setLogSecrets([]);
    setLogLevel("info");
  });
  setLogSecrets([SECRET]);
  setLogLevel("info");
  const log = createLogger().child("test");
  log.debug(`hidden ${SECRET}`);
  log.info(`calling with ${SECRET}\nsecond line`, { url: `http://h/?apikey=${SECRET}`, err: new Error(`boom ${SECRET}`) });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes(SECRET));
  assert.ok(!lines[0]!.includes("\n"));
  assert.match(lines[0]!, /INFO \[test\] calling with ••••/);
});
