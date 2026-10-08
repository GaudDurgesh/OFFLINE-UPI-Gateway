import assert from "node:assert/strict";
import {
  generateDeviceKeyPair,
  signMessage,
  verifyMessage,
} from "../crypto/signature.js";

const alice = generateDeviceKeyPair();
const otherDevice = generateDeviceKeyPair();

const message = Buffer.from("Send 10000 paise to Bob", "utf8");
const signature = signMessage(message, alice.privateKey);

assert.equal(
  verifyMessage(message, signature, alice.publicKey),
  true,
);
console.log("PASS: valid signature accepted.");

const modified = Buffer.from("Send 90000 paise to Bob", "utf8");

assert.equal(
  verifyMessage(modified, signature, alice.publicKey),
  false,
);
console.log("PASS: modified message rejected.");

assert.equal(
  verifyMessage(message, signature, otherDevice.publicKey),
  false,
);
console.log("PASS: wrong public key rejected.");

assert.equal(
  verifyMessage(message, "invalid-signature", alice.publicKey),
  false,
);
console.log("PASS: malformed signature rejected.");

assert.equal(
  verifyMessage(message, signature, "invalid-public-key"),
  false,
);
console.log("PASS: malformed public key rejected.");