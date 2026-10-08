import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { encodePayment } from "../domain/payment.js";
import {
  generateDeviceKeyPair,
  signMessage,
} from "../crypto/signature.js";
import { verifyPayment } from "../services/verify-payment.js";

async function checkDeviceVerification() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This check is allowed only in development.");
  }

  const senderId = randomUUID();
  const receiverId = randomUUID();
  const deviceId = randomUUID();
  const keys = generateDeviceKeyPair();
  const otherKeys = generateDeviceKeyPair();
  const rollbackSignal = new Error("Rollback temporary verification data");

  await assert.rejects(
    () =>
      withTransaction(async (client) => {
        await client.query(
          `INSERT INTO accounts (id, vpa, name)
           VALUES ($1, $2, 'Test Sender'), ($3, $4, 'Test Receiver')`,
          [
            senderId,
            `test-${senderId}@mesh`,
            receiverId,
            `test-${receiverId}@mesh`,
          ],
        );

        await client.query(
          `INSERT INTO devices (id, account_id, public_key_pem)
           VALUES ($1, $2, $3)`,
          [deviceId, senderId, keys.publicKey],
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

        const signPayment = (value: unknown) =>
          signMessage(encodePayment(value), keys.privateKey);

        const signature = signPayment(payment);

        const valid = await verifyPayment(client, payment, signature);
        assert.equal(valid.status, "VERIFIED");
        console.log("PASS: registered device payment verified.");

        const unknownDevice = {
          ...payment,
          deviceId: randomUUID(),
        };

        assert.deepEqual(
          await verifyPayment(
            client,
            unknownDevice,
            signPayment(unknownDevice),
          ),
          { status: "INVALID", reason: "UNKNOWN_DEVICE" },
        );
        console.log("PASS: unknown device rejected.");

        const wrongOwner = {
          ...payment,
          senderAccountId: receiverId,
          receiverAccountId: senderId,
        };

        assert.deepEqual(
          await verifyPayment(client, wrongOwner, signPayment(wrongOwner)),
          { status: "INVALID", reason: "DEVICE_ACCOUNT_MISMATCH" },
        );
        console.log("PASS: device cannot authorize another account.");

        assert.deepEqual(
          await verifyPayment(
            client,
            { ...payment, amountPaise: "90000" },
            signature,
          ),
          { status: "INVALID", reason: "INVALID_SIGNATURE" },
        );
        console.log("PASS: changed amount rejected.");

        const forgedSignature = signMessage(
          encodePayment(payment),
          otherKeys.privateKey,
        );

        assert.deepEqual(
          await verifyPayment(client, payment, forgedSignature),
          { status: "INVALID", reason: "INVALID_SIGNATURE" },
        );
        console.log("PASS: signature from another private key rejected.");

        assert.deepEqual(
          await verifyPayment(
            client,
            { ...payment, amountPaise: "0" },
            signature,
          ),
          { status: "INVALID", reason: "INVALID_PAYLOAD" },
        );
        console.log("PASS: invalid payload rejected.");

        await client.query(
          "UPDATE devices SET status = 'revoked' WHERE id = $1",
          [deviceId],
        );

        assert.deepEqual(
          await verifyPayment(client, payment, signature),
          { status: "INVALID", reason: "DEVICE_REVOKED" },
        );
        console.log("PASS: revoked device rejected.");

        throw rollbackSignal;
      }),
    (error: unknown) => error === rollbackSignal,
  );

  const remaining = await pool.query(
    "SELECT id FROM accounts WHERE id IN ($1, $2)",
    [senderId, receiverId],
  );

  assert.equal(remaining.rows.length, 0);
  console.log("PASS: temporary verification data rolled back.");
}

try {
  await checkDeviceVerification();
} catch (error) {
  console.error(
    "Device verification check failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}