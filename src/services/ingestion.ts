import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { withTransaction } from "../db/tx.js";
import { decryptPacket } from "../crypto/hybrid.js";
import { validatePacket } from "../domain/packet.js";
import { paymentSchema } from "../domain/payment.js";
import { verifyPayment } from "./verify-payment.js";
import { settleInTransaction } from "./settlement.js";
import { claimPacket, finishPacket } from "./packet-store.js";
import { claimPaymentIntent } from "./payment-intents.js";
import type { PacketOutcome } from "./packet-store.js";

const signedPaymentSchema = z
    .object({
        payment: paymentSchema,
        signature: z.string().length(88),
    })
    .strict();

const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

type IngestResult = {
    packetHash: string | null;
    repeated: boolean;
    outcome: PacketOutcome;
};

export async function ingestPacket(
    input: unknown,
    serverPrivateKey: KeyObject,
): Promise<IngestResult> {
    const receivedAt = Date.now();
    const validated = validatePacket(input);

    if (!validated.ok) {
        return {
            packetHash: null,
            repeated: false,
            outcome: {
                status: "INVALID",
                reason: "INVALID_PACKET",
            },
        };
    }

    const { packet, packetHash } = validated;

    return withTransaction<IngestResult>(async (client) => {
        const claim = await claimPacket(client, packetHash);

        if (!claim.claimed) {
            return {
                packetHash,
                repeated: true,
                outcome: claim.outcome,
            };
        }

        async function complete(
            outcome: PacketOutcome,
        ): Promise<IngestResult> {
            await finishPacket(client, packetHash, outcome);

            return {
                packetHash,
                repeated: false,
                outcome,
            };
        }

        const decrypted = decryptPacket(
            packet.ciphertext,
            serverPrivateKey,
        );

        if (!decrypted.ok) {
            return complete({
                status: "INVALID",
                reason: "DECRYPTION_FAILED",
            });
        }

        let decoded: unknown;

        try {
            decoded = JSON.parse(decrypted.plaintext.toString("utf8"));
        } catch {
            return complete({
                status: "INVALID",
                reason: "INVALID_JSON",
            });
        }

        const envelope = signedPaymentSchema.safeParse(decoded);

        if (!envelope.success) {
            return complete({
                status: "INVALID",
                reason: "INVALID_ENVELOPE",
            });
        }

        const verified = await verifyPayment(
            client,
            envelope.data.payment,
            envelope.data.signature,
        );

        if (verified.status === "INVALID") {
            return complete(verified);
        }

        const payment = verified.payment;
        const ageMs = receivedAt - payment.signedAt;
        const maxAgeMs = config.PACKET_MAX_AGE_HOURS * 60 * 60 * 1000;

        if (ageMs > maxAgeMs) {
            return complete({
                status: "INVALID",
                reason: "STALE_PAYMENT",
            });
        }

        if (ageMs < -FUTURE_CLOCK_SKEW_MS) {
            return complete({
                status: "INVALID",
                reason: "FUTURE_DATED_PAYMENT",
            });
        }

        const intent = await claimPaymentIntent(
            client,
            payment,
            packetHash,
        );

        if (!intent.claimed) {
            return complete(intent.outcome);
        }

        const settlement = await settleInTransaction(client, {
            paymentId: payment.paymentId,
            senderAccountId: payment.senderAccountId,
            receiverAccountId: payment.receiverAccountId,
            amountPaise: BigInt(payment.amountPaise),
        });

        return complete(settlement);
    });
}