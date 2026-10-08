import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { loadServerKeys } from "../crypto/server-keys.js";
import { generateDeviceKeyPair } from "../crypto/signature.js";
import { validatePacket } from "../domain/packet.js";
import type { MeshPacket } from "../domain/packet.js";
import { buildPacket } from "../services/build-packet.js";
import { ingestPacket } from "../services/ingestion.js";

async function checkIngestion() {
    if (config.NODE_ENV !== "development") {
        throw new Error("This check is allowed only in development.");
    }

    const serverKeys = await loadServerKeys();
    const deviceKeys = generateDeviceKeyPair();

    const senderId = randomUUID();
    const receiverId = randomUUID();
    const deviceId = randomUUID();
    const packetHashes = new Set<string>();

    async function deliver(packet: MeshPacket) {
        const validated = validatePacket(packet);
        assert.ok(validated.ok);

        packetHashes.add(validated.packetHash);
        return ingestPacket(packet, serverKeys.privateKey);
    }

    try {
        await pool.query(
            `INSERT INTO accounts (id, vpa, name, balance_paise)
       VALUES
         ($1, $2, 'Ingestion Sender', 50000),
         ($3, $4, 'Ingestion Receiver', 0)`,
            [
                senderId,
                `test-${senderId}@mesh`,
                receiverId,
                `test-${receiverId}@mesh`,
            ],
        );

        await pool.query(
            `INSERT INTO devices (id, account_id, public_key_pem)
       VALUES ($1, $2, $3)`,
            [deviceId, senderId, deviceKeys.publicKey],
        );

        const payment = {
            version: 1,
            paymentId: randomUUID(),
            deviceId,
            senderAccountId: senderId,
            receiverAccountId: receiverId,
            amountPaise: "10000",
            counter: "1",
            signedAt: Date.now(),
        };

        const packet = buildPacket(
            payment,
            deviceKeys.privateKey,
            serverKeys.publicKey,
        );

        // Wait for every delivery before checking results or cleaning up.
        const attempts = await Promise.allSettled(
            Array.from({ length: 3 }, () => deliver(packet)),
        );

        const results = attempts.map((attempt) => {
            if (attempt.status === "rejected") {
                throw attempt.reason;
            }

            return attempt.value;
        });

        assert.equal(results.filter((result) => !result.repeated).length, 1);
        assert.equal(results.filter((result) => result.repeated).length, 2);

        const transactionIds = new Set<string>();

        for (const result of results) {
            assert.ok(result.outcome.status === "SETTLED");
            transactionIds.add(result.outcome.transactionId);
        }

        assert.equal(transactionIds.size, 1);
        console.log("PASS: 3 simultaneous deliveries share one settlement.");

        const repeated = await deliver(packet);
        assert.equal(repeated.repeated, true);
        assert.deepEqual(repeated.outcome, results[0]!.outcome);

        console.log("PASS: later delivery returns the stored settlement.");

        const rebuiltPacket = buildPacket(
            payment,
            deviceKeys.privateKey,
            serverKeys.publicKey,
        );

        const rebuilt = await deliver(rebuiltPacket);

        assert.equal(rebuilt.repeated, false);
        assert.ok(rebuilt.outcome.status === "DUPLICATE");
        assert.ok(transactionIds.has(rebuilt.outcome.transactionId));

        console.log("PASS: re-encrypted payment does not settle again.");

        const accounts = await pool.query<{
            id: string;
            balance_paise: string;
        }>(
            "SELECT id, balance_paise FROM accounts WHERE id IN ($1, $2)",
            [senderId, receiverId],
        );

        assert.equal(
            accounts.rows.find((row) => row.id === senderId)?.balance_paise,
            "40000",
        );

        assert.equal(
            accounts.rows.find((row) => row.id === receiverId)?.balance_paise,
            "10000",
        );

        const ledger = await pool.query(
            "SELECT id FROM transactions WHERE payment_id = $1",
            [payment.paymentId],
        );

        assert.equal(ledger.rows.length, 1);

        console.log("PASS: exactly ₹100 moved and one ledger row exists.");
        let nextCounter = 2;

        function buildCase(
            changes: Partial<typeof payment> = {},
            privateKey = deviceKeys.privateKey,
        ) {
            return buildPacket(
                {
                    ...payment,
                    paymentId: randomUUID(),
                    counter: String(nextCounter++),
                    signedAt: Date.now(),
                    ...changes,
                },
                privateKey,
                serverKeys.publicKey,
            );
        }

        async function expectFailure(
            label: string,
            testPacket: MeshPacket,
            expected: {
                status: "INVALID" | "REJECTED";
                reason: string;
            },
        ) {
            const first = await deliver(testPacket);
            assert.equal(first.repeated, false);
            assert.deepEqual(first.outcome, expected);

            const retry = await deliver(testPacket);
            assert.equal(retry.repeated, true);
            assert.deepEqual(retry.outcome, expected);

            console.log(`PASS: ${label}; retry returns the stored outcome.`);
        }

        // Tamper with encrypted data while keeping the packet format valid.
        const tampered = buildCase();
        const bytes = Buffer.from(tampered.ciphertext, "base64");
        bytes[268] = bytes[268]! ^ 1;
        tampered.ciphertext = bytes.toString("base64");

        await expectFailure("tampered ciphertext rejected", tampered, {
            status: "INVALID",
            reason: "DECRYPTION_FAILED",
        });

        const attackerKeys = generateDeviceKeyPair();

        await expectFailure(
            "wrong signing key rejected",
            buildCase({}, attackerKeys.privateKey),
            {
                status: "INVALID",
                reason: "INVALID_SIGNATURE",
            },
        );

        await expectFailure(
            "wrong account owner rejected",
            buildCase({
                senderAccountId: receiverId,
                receiverAccountId: senderId,
            }),
            {
                status: "INVALID",
                reason: "DEVICE_ACCOUNT_MISMATCH",
            },
        );

        await expectFailure(
            "stale payment rejected",
            buildCase({
                signedAt:
                    Date.now() -
                    config.PACKET_MAX_AGE_HOURS * 60 * 60 * 1000 -
                    60000,
            }),
            {
                status: "INVALID",
                reason: "STALE_PAYMENT",
            },
        );

        await expectFailure(
            "future-dated payment rejected",
            buildCase({
                signedAt: Date.now() + 10 * 60 * 1000,
            }),
            {
                status: "INVALID",
                reason: "FUTURE_DATED_PAYMENT",
            },
        );

        // Sender has 40000 paise remaining after the successful payment.
        await expectFailure(
            "insufficient funds rejected",
            buildCase({ amountPaise: "40001" }),
            {
                status: "REJECTED",
                reason: "INSUFFICIENT_FUNDS",
            },
        );

        await pool.query(
            "UPDATE devices SET status = 'revoked' WHERE id = $1",
            [deviceId],
        );

        await expectFailure(
            "revoked device rejected",
            buildCase(),
            {
                status: "INVALID",
                reason: "DEVICE_REVOKED",
            },
        );

        const finalAccounts = await pool.query<{
            id: string;
            balance_paise: string;
        }>(
            "SELECT id, balance_paise FROM accounts WHERE id IN ($1, $2)",
            [senderId, receiverId],
        );

        assert.equal(
            finalAccounts.rows.find((row) => row.id === senderId)?.balance_paise,
            "40000",
        );

        assert.equal(
            finalAccounts.rows.find((row) => row.id === receiverId)?.balance_paise,
            "10000",
        );

        const finalLedger = await pool.query(
            `SELECT id FROM transactions
       WHERE sender_account_id IN ($1, $2)
          OR receiver_account_id IN ($1, $2)`,
            [senderId, receiverId],
        );

        assert.equal(finalLedger.rows.length, 1);

        console.log("PASS: rejected packets left balances and ledger unchanged.");
    } finally {
        await withTransaction(async (client) => {
            // Packet records reference transactions, so remove them first.
            await client.query(
                "DELETE FROM packets WHERE packet_hash = ANY($1::text[])",
                [[...packetHashes]],
            );

            await client.query(
                `DELETE FROM transactions
         WHERE sender_account_id IN ($1, $2)
            OR receiver_account_id IN ($1, $2)`,
                [senderId, receiverId],
            );

            await client.query(
                "DELETE FROM devices WHERE id = $1",
                [deviceId],
            );

            await client.query(
                "DELETE FROM accounts WHERE id IN ($1, $2)",
                [senderId, receiverId],
            );
        });

        console.log("Temporary ingestion data removed.");
    }
}

try {
    await checkIngestion();
} catch (error) {
    console.error("Ingestion check failed:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}