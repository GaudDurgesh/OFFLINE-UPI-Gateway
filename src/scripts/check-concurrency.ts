import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { settle } from "../services/settlement.js";

// Wait for every request before inspecting results or cleaning up.
async function completeAll<T>(requests: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(requests);

  return results.map((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }

    return result.value;
  });
}

async function checkConcurrency() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This check is allowed only in development.");
  }

  const senderId = randomUUID();
  const receiverId = randomUUID();

  try {
    await pool.query(
      `INSERT INTO accounts (id, vpa, name, balance_paise)
       VALUES
         ($1, $2, 'Test Sender', 50000),
         ($3, $4, 'Test Receiver', 0)`,
      [
        senderId,
        `test-${senderId}@mesh`,
        receiverId,
        `test-${receiverId}@mesh`,
      ],
    );

    const payment = {
      paymentId: randomUUID(),
      senderAccountId: senderId,
      receiverAccountId: receiverId,
      amountPaise: 10000n,
    };

    // Test 1: twenty simultaneous attempts at the SAME ₹100 payment.
    const duplicates = await completeAll(
      Array.from({ length: 20 }, () => settle(payment)),
    );

    assert.equal(
      duplicates.filter((result) => result.status === "SETTLED").length,
      1,
    );

    assert.equal(
      duplicates.filter((result) => result.status === "DUPLICATE").length,
      19,
    );

    console.log("PASS: 20 duplicate attempts -> 1 settled, 19 duplicates.");

    // Sender now has ₹400.
    // Test 2: fifty DIFFERENT ₹100 payments compete for that balance.
    const payments = await completeAll(
      Array.from({ length: 50 }, () =>
        settle({
          ...payment,
          paymentId: randomUUID(),
        }),
      ),
    );

    assert.equal(
      payments.filter((result) => result.status === "SETTLED").length,
      4,
    );

    assert.equal(
      payments.filter(
        (result) =>
          result.status === "REJECTED" &&
          result.reason === "INSUFFICIENT_FUNDS",
      ).length,
      46,
    );

    console.log("PASS: 50 new payments -> 4 settled, 46 insufficient funds.");

    const accounts = await pool.query<{
      id: string;
      balance_paise: string;
    }>(
      "SELECT id, balance_paise FROM accounts WHERE id IN ($1, $2)",
      [senderId, receiverId],
    );

    const sender = accounts.rows.find((row) => row.id === senderId);
    const receiver = accounts.rows.find((row) => row.id === receiverId);

    assert.ok(sender);
    assert.ok(receiver);
    assert.equal(BigInt(sender.balance_paise), 0n);
    assert.equal(BigInt(receiver.balance_paise), 50000n);

    const ledger = await pool.query(
      "SELECT id FROM transactions WHERE sender_account_id = $1",
      [senderId],
    );

    assert.equal(ledger.rows.length, 5);

    console.log("PASS: total ₹500 preserved, no overdraft, 5 ledger rows.");
  } finally {
    // Remove only this run's temporary data.
    await withTransaction(async (client) => {
      await client.query(
        `DELETE FROM transactions
         WHERE sender_account_id IN ($1, $2)
            OR receiver_account_id IN ($1, $2)`,
        [senderId, receiverId],
      );

      await client.query(
        "DELETE FROM accounts WHERE id IN ($1, $2)",
        [senderId, receiverId],
      );
    });

    console.log("Temporary test data removed.");
  }
}

try {
  await checkConcurrency();
} catch (error) {
  console.error(
    "Concurrency check failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}