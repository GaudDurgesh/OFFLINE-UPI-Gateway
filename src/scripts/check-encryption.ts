import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { loadServerKeys } from "../crypto/server-keys.js";
import { encryptPacket, decryptPacket } from "../crypto/hybrid.js";

async function checkEncryption() {
  const keys = await loadServerKeys();
  const message = Buffer.from("Test payment: 10000 paise", "utf8");

  const encrypted = encryptPacket(message, keys.publicKey);
  const decrypted = decryptPacket(encrypted, keys.privateKey);

  assert.equal(decrypted.ok, true);

  if (!decrypted.ok) {
    throw new Error("Round-trip decryption failed.");
  }

  assert.deepEqual(decrypted.plaintext, message);
  console.log("PASS: encryption/decryption round trip.");

  const secondPacket = encryptPacket(message, keys.publicKey);

  assert.notEqual(encrypted, secondPacket);
  console.log("PASS: repeated encryption produces different ciphertext.");

  // Reload the saved files rather than generating replacement keys.
  const reloadedKeys = await loadServerKeys();
  const afterReload = decryptPacket(encrypted, reloadedKeys.privateKey);

  assert.equal(afterReload.ok, true);

  if (!afterReload.ok) {
    throw new Error("Decryption with reloaded keys failed.");
  }

  assert.deepEqual(afterReload.plaintext, message);
  console.log("PASS: saved keys decrypt an existing packet after reload.");

  const packet = Buffer.from(encrypted, "base64");

  const regions = [
    { name: "wrapped AES key", offset: 0 },
    { name: "IV", offset: 256 },
    { name: "ciphertext", offset: 268 },
    { name: "authentication tag", offset: packet.length - 1 },
  ];

  for (const region of regions) {
    const modified = Buffer.from(packet);
    modified[region.offset] = modified[region.offset]! ^ 1;

    assert.deepEqual(
      decryptPacket(modified.toString("base64"), keys.privateKey),
      { ok: false, reason: "INVALID_CIPHERTEXT" },
    );

    console.log(`PASS: tampered ${region.name} rejected.`);
  }

  for (const length of [0, 100, 284, packet.length - 1]) {
    const truncated = packet.subarray(0, length).toString("base64");

    assert.equal(
      decryptPacket(truncated, keys.privateKey).ok,
      false,
    );
  }
  console.log("PASS: truncated packets rejected.");

  for (const invalid of ["not-base64!", `${encrypted}\n`, "A".repeat(6000)]) {
    assert.equal(decryptPacket(invalid, keys.privateKey).ok, false);
  }
  console.log("PASS: malformed and oversized encodings rejected.");

  const otherKeys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  assert.equal(
    decryptPacket(encrypted, otherKeys.privateKey).ok,
    false,
  );
  console.log("PASS: wrong private key rejected.");

  const boundaryMessage = Buffer.alloc(4096, 65);
  const boundaryPacket = encryptPacket(boundaryMessage, keys.publicKey);
  const boundaryResult = decryptPacket(boundaryPacket, keys.privateKey);

  assert.equal(boundaryResult.ok, true);

  if (!boundaryResult.ok) {
    throw new Error("Maximum-size message failed.");
  }

  assert.deepEqual(boundaryResult.plaintext, boundaryMessage);

  assert.throws(() => encryptPacket(Buffer.alloc(0), keys.publicKey));
  assert.throws(() => encryptPacket(Buffer.alloc(4097), keys.publicKey));

  console.log("PASS: plaintext size limits enforced.");
}

try {
  await checkEncryption();
} catch (error) {
  console.error(
    "Encryption check failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
}