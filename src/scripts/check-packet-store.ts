import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { claimPacket, finishPacket } from "../services/packet-store.js";

const outcome = {
  status: "INVALID",
  reason: "TEST_PACKET",
} as const;

async function processTestPacket(packetHash: string) {
  return withTransaction(async (client) => {
    const claim = await claimPacket(client, packetHash);

    if (claim.claimed) {
      await finishPacket(client, packetHash, outcome);
    }

    return claim;
  });
}

async function checkPacketStore() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This check is allowed only in development.");
  }

  const hashes = Array.from(
    { length: 3 },
    () => randomBytes(32).toString("hex"),
  );

  const [repeatHash, rollbackHash, concurrentHash] = hashes as [
    string,
    string,
    string,
  ];

  try {
    // Test 1: final outcomes survive across database transactions.
    const first = await processTestPacket(repeatHash);
    assert.deepEqual(first, { claimed: true });

    const repeated = await processTestPacket(repeatHash);

    assert.deepEqual(repeated, {
      claimed: false,
      outcome,
    });

    console.log("PASS: repeated claim returns the stored final outcome.");

    // Test 2: failure after claiming must leave no committed packet.
    const forcedFailure = new Error("Intentional claim rollback");

    await assert.rejects(
      () =>
        withTransaction(async (client) => {
          const claim = await claimPacket(client, rollbackHash);
          assert.deepEqual(claim, { claimed: true });

          throw forcedFailure;
        }),
      (error: unknown) => error === forcedFailure,
    );

    const afterRollback = await pool.query(
      "SELECT packet_hash FROM packets WHERE packet_hash = $1",
      [rollbackHash],
    );

    assert.equal(afterRollback.rows.length, 0);
    console.log("PASS: failed transaction leaves no packet claim.");

    const retry = await processTestPacket(rollbackHash);
    assert.deepEqual(retry, { claimed: true });

    assert.deepEqual(await processTestPacket(rollbackHash), {
      claimed: false,
      outcome,
    });

    console.log("PASS: rolled-back packet can be retried and finalized.");

    // Test 3: wait for every request before assertions or cleanup.
    const attempts = await Promise.allSettled(
      Array.from(
        { length: 10 },
        () => processTestPacket(concurrentHash),
      ),
    );

    let winners = 0;
    let repeats = 0;

    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        throw attempt.reason;
      }

      if (attempt.value.claimed) {
        winners++;
      } else {
        repeats++;
        assert.deepEqual(attempt.value.outcome, outcome);
      }
    }

    assert.equal(winners, 1);
    assert.equal(repeats, 9);

    console.log("PASS: 10 simultaneous claims -> 1 winner, 9 stored outcomes.");
  } finally {
    await pool.query(
      "DELETE FROM packets WHERE packet_hash = ANY($1::text[])",
      [hashes],
    );

    console.log("Temporary packet records removed.");
  }
}

try {
  await checkPacketStore();
} catch (error) {
  console.error("Packet store check failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}