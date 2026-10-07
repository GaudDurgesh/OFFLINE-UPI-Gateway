import assert from "node:assert/strict";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { settle } from "../services/settlement.js";

type AccountRow = {
  id: string;
  vpa: string;
  balance_paise: string;
};

async function readAccounts() {
  const result = await pool.query<AccountRow>(
    `SELECT id, vpa, balance_paise
     FROM accounts
     WHERE vpa IN ('alice@mesh', 'bob@mesh')
     ORDER BY vpa`,
  );

  const alice = result.rows.find((row) => row.vpa === "alice@mesh");
  const bob = result.rows.find((row) => row.vpa === "bob@mesh");

  if (!alice || !bob) {
    throw new Error("Demo accounts are missing. Run npm run seed.");
  }

  return { alice, bob };
}

async function checkSettlement() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This check is allowed only in development.");
  }

  const before = await readAccounts();

  const payment = {
    paymentId: "b52e7d91-ef90-4c81-8f65-7d9a910032a6",
    senderAccountId: before.alice.id,
    receiverAccountId: before.bob.id,
    amountPaise: 10000n,
  };

  const first = await settle(payment);
  console.log("First attempt:", first);

  assert.ok(
    first.status === "SETTLED" || first.status === "DUPLICATE",
    "Expected a successful or previously settled payment",
  );

  const second = await settle(payment);
  console.log("Second attempt:", second);

  assert.equal(second.status, "DUPLICATE");

  if (second.status !== "DUPLICATE") {
    throw new Error("Duplicate protection failed.");
  }

  assert.equal(second.transactionId, first.transactionId);

  const after = await readAccounts();
  const moved = first.status === "SETTLED" ? payment.amountPaise : 0n;

  assert.equal(
    BigInt(after.alice.balance_paise),
    BigInt(before.alice.balance_paise) - moved,
  );

  assert.equal(
    BigInt(after.bob.balance_paise),
    BigInt(before.bob.balance_paise) + moved,
  );

  const ledger = await pool.query(
    "SELECT id FROM transactions WHERE payment_id = $1",
    [payment.paymentId],
  );

  assert.equal(ledger.rows.length, 1);

  console.table([after.alice, after.bob]);
  console.log("PASS: correct balances, one ledger row, duplicate blocked.");
}

try {
  await checkSettlement();
} catch (error) {
  console.error(
    "Settlement check failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}