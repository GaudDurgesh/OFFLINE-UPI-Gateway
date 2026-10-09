import assert from "node:assert/strict";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";

async function checkTimeouts() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This check is allowed only in development.");
  }

  await withTransaction(async (client) => {
    const result = await client.query(`
      SELECT
        EXTRACT(
          EPOCH FROM current_setting('statement_timeout')::interval
        ) * 1000 AS statement_ms,
        EXTRACT(
          EPOCH FROM current_setting('lock_timeout')::interval
        ) * 1000 AS lock_ms,
        EXTRACT(
          EPOCH FROM
          current_setting('idle_in_transaction_session_timeout')::interval
        ) * 1000 AS idle_transaction_ms
    `);

    const row = result.rows[0];

    assert.equal(Number(row.statement_ms), 8000);
    assert.equal(Number(row.lock_ms), 3000);
    assert.equal(Number(row.idle_transaction_ms), 10000);

    console.log("PASS: transaction has all three timeout settings.");
  });

  await assert.rejects(
    withTransaction(async (client) => {
      await client.query("SELECT pg_sleep(10)");
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "57014",
    "Expected PostgreSQL statement cancellation",
  );

  console.log("PASS: PostgreSQL cancelled the slow statement.");

  await withTransaction(async (client) => {
    const result = await client.query("SELECT 1 AS value");
    assert.equal(result.rows[0].value, 1);
  });

  console.log("PASS: a new transaction succeeds after the timeout.");
}

try {
  await checkTimeouts();
} catch (error) {
  console.error("Database timeout check failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}