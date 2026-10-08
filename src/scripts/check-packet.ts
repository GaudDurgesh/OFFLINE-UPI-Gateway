import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadServerKeys } from "../crypto/server-keys.js";
import {
  generateDeviceKeyPair,
  verifyMessage,
} from "../crypto/signature.js";
import { decryptPacket } from "../crypto/hybrid.js";
import { paymentSchema, encodePayment } from "../domain/payment.js";
import { buildPacket } from "../services/build-packet.js";

const envelopeSchema = z
  .object({
    payment: paymentSchema,
    signature: z.string().length(88),
  })
  .strict();

async function checkPacket() {
  const serverKeys = await loadServerKeys();
  const deviceKeys = generateDeviceKeyPair();

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

  const packet = buildPacket(
    payment,
    deviceKeys.privateKey,
    serverKeys.publicKey,
  );

  assert.deepEqual(
    Object.keys(packet).sort(),
    ["packetId", "ttl", "createdAt", "ciphertext"].sort(),
  );
  assert.equal(packet.ttl, 5);
  console.log("PASS: relay packet has the expected outer fields.");

  const decrypted = decryptPacket(
    packet.ciphertext,
    serverKeys.privateKey,
  );

  assert.equal(decrypted.ok, true);

  if (!decrypted.ok) {
    throw new Error("Packet decryption failed.");
  }

  const envelope = envelopeSchema.parse(
    JSON.parse(decrypted.plaintext.toString("utf8")),
  );

  assert.deepEqual(envelope.payment, payment);
  console.log("PASS: decrypted payment matches the original.");

  assert.equal(
    verifyMessage(
      encodePayment(envelope.payment),
      envelope.signature,
      deviceKeys.publicKey,
    ),
    true,
  );
  console.log("PASS: device signature remains valid after decryption.");

  const secondPacket = buildPacket(
    payment,
    deviceKeys.privateKey,
    serverKeys.publicKey,
  );

  assert.notEqual(secondPacket.packetId, packet.packetId);
  assert.notEqual(secondPacket.ciphertext, packet.ciphertext);
  console.log("PASS: rebuilding creates a different encrypted packet.");

  assert.throws(() =>
    buildPacket(
      { ...payment, amountPaise: "-100" },
      deviceKeys.privateKey,
      serverKeys.publicKey,
    ),
  );
  console.log("PASS: invalid payment rejected before packet creation.");
}

try {
  await checkPacket();
} catch (error) {
  console.error(
    "Packet check failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
}