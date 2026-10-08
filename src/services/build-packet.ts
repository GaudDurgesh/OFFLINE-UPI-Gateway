import { randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { paymentSchema, encodePayment } from "../domain/payment.js";
import { signMessage } from "../crypto/signature.js";
import { encryptPacket } from "../crypto/hybrid.js";
import type { MeshPacket } from "../domain/packet.js";


export function buildPacket(
  input: unknown,
  devicePrivateKeyPem: string,
  serverPublicKey: KeyObject,
): MeshPacket {
  const payment = paymentSchema.parse(input);

  const signature = signMessage(
    encodePayment(payment),
    devicePrivateKeyPem,
  );

  const plaintext = Buffer.from(
    JSON.stringify({ payment, signature }),
    "utf8",
  );

  return {
    packetId: randomUUID(),
    ttl: 5,
    createdAt: Date.now(),
    ciphertext: encryptPacket(plaintext, serverPublicKey),
  };
}