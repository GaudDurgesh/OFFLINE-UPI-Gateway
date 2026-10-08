import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadServerKeys } from "../crypto/server-keys.js";
import { generateDeviceKeyPair } from "../crypto/signature.js";
import { buildPacket } from "../services/build-packet.js";
import { validatePacket } from "../domain/packet.js";

async function checkPacketValidation() {
  const serverKeys = await loadServerKeys();
  const deviceKeys = generateDeviceKeyPair();

  const packet = buildPacket(
    {
      version: 1,
      paymentId: randomUUID(),
      deviceId: randomUUID(),
      senderAccountId: randomUUID(),
      receiverAccountId: randomUUID(),
      amountPaise: "10000",
      counter: "1",
      signedAt: Date.now(),
    },
    deviceKeys.privateKey,
    serverKeys.publicKey,
  );

  const original = validatePacket(packet);
  assert.ok(original.ok);
  assert.match(original.packetHash, /^[0-9a-f]{64}$/);
  console.log("PASS: valid packet accepted and hashed.");

  const relayCopy = validatePacket({
    ...packet,
    packetId: randomUUID(),
    ttl: 0,
    createdAt: packet.createdAt + 1000,
  });

  assert.ok(relayCopy.ok);
  assert.equal(relayCopy.packetHash, original.packetHash);
  console.log("PASS: relay metadata changes do not change the hash.");

  const modifiedBytes = Buffer.from(packet.ciphertext, "base64");
  modifiedBytes[268] = modifiedBytes[268]! ^ 1;

  const modified = validatePacket({
    ...packet,
    ciphertext: modifiedBytes.toString("base64"),
  });

  assert.ok(modified.ok);
  assert.notEqual(modified.packetHash, original.packetHash);
  console.log("PASS: changed encrypted bytes produce a different hash.");

  for (const ciphertext of [
    "",
    "not-base64!",
    `${packet.ciphertext}\n`,
    Buffer.alloc(284).toString("base64"),
    "A".repeat(6000),
  ]) {
    assert.equal(validatePacket({ ...packet, ciphertext }).ok, false);
  }
  console.log("PASS: malformed and incorrectly sized ciphertext rejected.");

  for (const invalid of [
    { ...packet, packetId: "invalid" },
    { ...packet, ttl: -1 },
    { ...packet, ttl: 6 },
    { ...packet, createdAt: "yesterday" },
    { ...packet, unexpected: true },
  ]) {
    assert.equal(validatePacket(invalid).ok, false);
  }
  console.log("PASS: invalid outer fields rejected.");
}

try {
  await checkPacketValidation();
} catch (error) {
  console.error("Packet validation check failed:", error);
  process.exitCode = 1;
}