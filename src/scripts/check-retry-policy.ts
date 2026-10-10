import assert from "node:assert/strict";
import { retryDelayMs } from "../bridge/retry-policy.js";

const now = Date.UTC(2026, 9, 10, 12, 0, 0);

assert.equal(retryDelayMs(1, null, now, 0), 500);
assert.equal(retryDelayMs(2, null, now, 0), 1_000);
assert.equal(retryDelayMs(3, null, now, 0), 2_000);
console.log("PASS: retry delays increase with failed attempts.");

assert.equal(retryDelayMs(100, null, now, 0), 30_000);
assert.ok(retryDelayMs(100, null, now, 0.999) < 60_000);
console.log("PASS: local backoff is capped and includes jitter.");

assert.equal(retryDelayMs(1, "120", now, 0), 120_000);
assert.equal(retryDelayMs(3, "0", now, 0), 2_000);
console.log("PASS: Retry-After seconds extend but never shorten backoff.");

const future = new Date(now + 180_000).toUTCString();
const past = new Date(now - 60_000).toUTCString();

assert.equal(retryDelayMs(1, future, now, 0), 180_000);
assert.equal(retryDelayMs(1, past, now, 0), 500);
console.log("PASS: HTTP-date retry guidance is handled.");

for (const header of [
  "",
  "-1",
  "1.5",
  "invalid",
  "9".repeat(128),
  "x".repeat(129),
]) {
  assert.equal(retryDelayMs(1, header, now, 0), 500);
}
console.log("PASS: invalid retry guidance falls back to local backoff.");

for (const attempt of [0, -1, 1.5, NaN, Infinity]) {
  assert.throws(() => retryDelayMs(attempt, null, now, 0));
}

for (const random of [-1, 1, NaN, Infinity]) {
  assert.throws(() => retryDelayMs(1, null, now, random));
}

assert.throws(() => retryDelayMs(1, null, -1, 0));
console.log("PASS: invalid policy inputs rejected.");