import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encodePayment, paymentSchema } from "../domain/payment.js";
import {
  generateDeviceKeyPair,
  signMessage,
  verifyMessage,
} from "../crypto/signature.js";

const keys = generateDeviceKeyPair();

const payment = {
  version: 1,
  paymentId: randomUUID(),
  deviceId: randomUUID(),
  senderAccountId: randomUUID(),
  receiverAccountId: randomUUID(),
  amountPaise: "10000",
  counter: "1",
  signedAt: Date.now(),
};

const bytes = encodePayment(payment);
const signature = signMessage(bytes, keys.privateKey);

assert.equal(verifyMessage(bytes, signature, keys.publicKey), true);
console.log("PASS: valid payment signature accepted.");

const reordered = Object.fromEntries(
  Object.entries(payment).reverse(),
);

assert.deepEqual(encodePayment(reordered), bytes);
console.log("PASS: input field order does not change signing bytes.");

const changedAmount = encodePayment({
  ...payment,
  amountPaise: "90000",
});

assert.equal(
  verifyMessage(changedAmount, signature, keys.publicKey),
  false,
);
console.log("PASS: changed payment amount rejected.");

for (const amountPaise of ["0", "-100", "10.5", "0100", "abc", 10000]) {
  assert.equal(
    paymentSchema.safeParse({ ...payment, amountPaise }).success,
    false,
  );
}
console.log("PASS: invalid amount formats rejected.");

assert.equal(
  paymentSchema.safeParse({ ...payment, unexpected: true }).success,
  false,
);
console.log("PASS: unexpected fields rejected.");