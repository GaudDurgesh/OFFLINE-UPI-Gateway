import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { encodePayment } from "../domain/payment.js";
import type { PaymentPayload } from "../domain/payment.js";
import type { PacketOutcome } from "./packet-store.js";

type IntentClaim =
  | { claimed: true }
  | { claimed: false; outcome: PacketOutcome };

type ExistingIntent = {
  payload_hash: string;
  status: "PROCESSING" | PacketOutcome["status"];
  transaction_id: string | null;
  reason: string | null;
};

// Call only after device verification and freshness checks.
export async function claimPaymentIntent(
  client: PoolClient,
  payment: PaymentPayload,
  packetHash: string,
): Promise<IntentClaim> {
  const payloadHash = createHash("sha256")
    .update(encodePayment(payment))
    .digest("hex");

  const inserted = await client.query(
    `INSERT INTO payment_intents (
       payment_id, device_id, counter, payload_hash, first_packet_hash
     )
     VALUES ($1, $2, $3::bigint, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING payment_id`,
    [
      payment.paymentId,
      payment.deviceId,
      payment.counter,
      payloadHash,
      packetHash,
    ],
  );

  if (inserted.rows.length === 1) {
    return { claimed: true };
  }

  const existing = await client.query<ExistingIntent>(
    `SELECT i.payload_hash, p.status, p.transaction_id, p.reason
     FROM payment_intents AS i
     JOIN packets AS p ON p.packet_hash = i.first_packet_hash
     WHERE i.payment_id = $1
        OR (i.device_id = $2 AND i.counter = $3::bigint)`,
    [payment.paymentId, payment.deviceId, payment.counter],
  );

  if (existing.rows.length === 0) {
    throw new Error("Payment intent disappeared after a claim conflict.");
  }

  const previous = existing.rows[0]!;

  if (
    existing.rows.length !== 1 ||
    previous.payload_hash !== payloadHash
  ) {
    return {
      claimed: false,
      outcome: {
        status: "INVALID",
        reason: "PAYMENT_INTENT_CONFLICT",
      },
    };
  }

  if (previous.status === "PROCESSING") {
    throw new Error("Unexpected unfinished payment intent.");
  }

  if (
    previous.status === "SETTLED" ||
    previous.status === "DUPLICATE"
  ) {
    if (previous.transaction_id === null) {
      throw new Error("Payment intent is missing its transaction ID.");
    }

    return {
      claimed: false,
      outcome: {
        status: "DUPLICATE",
        transactionId: previous.transaction_id,
      },
    };
  }

  if (previous.reason === null) {
    throw new Error("Payment intent is missing its failure reason.");
  }

  return {
    claimed: false,
    outcome: {
      status: previous.status,
      reason: previous.reason,
    },
  };
}