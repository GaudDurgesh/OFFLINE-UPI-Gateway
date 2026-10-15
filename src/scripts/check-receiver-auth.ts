import assert from "node:assert/strict";
import { createReceiverAuthenticator } from "../bridge/receiver-auth.js";

const token = `mesh_receiver_${"ab".repeat(32)}`;
const authenticate = createReceiverAuthenticator(token);

assert.equal(authenticate(`Bearer ${token}`), true);
assert.equal(authenticate(`bearer ${token}`), true);
console.log("PASS: correct receiver token accepted.");

assert.equal(
  authenticate(`Bearer mesh_receiver_${"cd".repeat(32)}`),
  false,
);
console.log("PASS: incorrect token rejected.");

for (const value of [
  undefined,
  null,
  "",
  123,
  `Basic ${token}`,
  `Bearer ${token} extra`,
  `Bearer ${token}\n`,
  `Bearer ${token.slice(0, -1)}`,
]) {
  assert.equal(authenticate(value), false);
}
console.log("PASS: missing and malformed credentials rejected.");

assert.equal(
  authenticate(`Bearer mesh_receiver_${"AB".repeat(32)}`),
  false,
);
console.log("PASS: changing token letter case is rejected.");

assert.throws(() => createReceiverAuthenticator(""));
assert.throws(() => createReceiverAuthenticator("invalid"));
console.log("PASS: invalid configured tokens rejected.");