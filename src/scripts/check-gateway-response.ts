import assert from "node:assert/strict";
import { validateGatewayResponse } from "../bridge/gateway-response.js";

const packetHash = "a".repeat(64);

function accepts(outcome: unknown): boolean {
  return validateGatewayResponse(
    { packetHash, repeated: false, outcome },
    packetHash,
  ).ok;
}

for (const status of ["SETTLED", "DUPLICATE"]) {
  assert.equal(
    accepts({ status, transactionId: "123" }),
    true,
  );
}
console.log("PASS: settlement and duplicate outcomes accepted.");

for (const status of ["INVALID", "REJECTED"]) {
  assert.equal(
    accepts({ status, reason: "TEST_REASON" }),
    true,
  );
}
console.log("PASS: terminal failure outcomes accepted.");

const valid = {
  packetHash,
  repeated: true,
  outcome: {
    status: "SETTLED",
    transactionId: "123",
  },
};

for (const wrongHash of [null, "b".repeat(64), "invalid"]) {
  assert.equal(
    validateGatewayResponse(
      { ...valid, packetHash: wrongHash },
      packetHash,
    ).ok,
    false,
  );
}
console.log("PASS: missing or mismatched packet hashes rejected.");

for (const transactionId of [
  "0",
  "-1",
  "01",
  "1.5",
  "abc",
  "9223372036854775808",
  123,
]) {
  assert.equal(
    accepts({ status: "SETTLED", transactionId }),
    false,
  );
}
console.log("PASS: invalid transaction IDs rejected.");

for (const outcome of [
  { status: "PROCESSING" },
  { status: "SETTLED" },
  { status: "REJECTED", reason: "" },
  { status: "INVALID", reason: "x".repeat(129) },
  { status: "REJECTED", reason: "TEST", transactionId: "1" },
]) {
  assert.equal(accepts(outcome), false);
}
console.log("PASS: incomplete and unexpected outcomes rejected.");

for (const response of [
  null,
  {},
  { ...valid, repeated: "true" },
  { ...valid, extra: true },
]) {
  assert.equal(
    validateGatewayResponse(response, packetHash).ok,
    false,
  );
}
console.log("PASS: malformed response envelopes rejected.");