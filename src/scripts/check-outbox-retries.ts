import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeOutbox } from "../bridge/outbox.js";

async function checkOutboxRetries() {
  const directory = await mkdtemp(
    join(tmpdir(), "gateway-retry-check-"),
  );

  let outbox: BridgeOutbox | undefined;

  try {
    outbox = new BridgeOutbox(directory);

    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    const packet = {
      packetId: randomUUID(),
      ttl: 5,
      createdAt: now,
      ciphertext: Buffer.alloc(285, 3).toString("base64"),
    };

    const { packetHash } = outbox.enqueue(packet);

    const first = outbox.scheduleRetry(packetHash, null, now, 0);

    assert.deepEqual(first, {
      attempts: 1,
      nextAttemptAt: now + 500,
    });
    assert.equal(outbox.listPending(100, now + 499).length, 0);
    assert.equal(outbox.listPending(100, now + 500).length, 1);

    console.log("PASS: packet becomes eligible exactly at its retry time.");

    outbox.close();
    outbox = undefined;
    outbox = new BridgeOutbox(directory);

    assert.deepEqual(outbox.getRetryState(packetHash), first);
    assert.equal(outbox.listPending(100, now + 499).length, 0);

    console.log("PASS: retry count and schedule survive reopening.");

    assert.equal(outbox.enqueue(packet).inserted, false);
    assert.deepEqual(outbox.getRetryState(packetHash), first);

    console.log("PASS: duplicate enqueue does not reset retry state.");

    const second = outbox.scheduleRetry(
      packetHash,
      "120",
      now + 500,
      0,
    );

    assert.deepEqual(second, {
      attempts: 2,
      nextAttemptAt: now + 120_500,
    });
    assert.equal(outbox.listPending(100, now + 120_499).length, 0);
    assert.equal(outbox.listPending(100, now + 120_500).length, 1);

    console.log("PASS: server retry guidance extends the saved schedule.");

    const third = outbox.scheduleRetry(
      packetHash,
      null,
      now + 600,
      0,
    );

    assert.equal(third.attempts, 3);
    assert.equal(third.nextAttemptAt, second.nextAttemptAt);

    console.log("PASS: another scheduling call cannot shorten the wait.");

    assert.throws(
      () => outbox!.scheduleRetry(packetHash, null, now, 1),
      /Random value/,
    );

    assert.deepEqual(outbox.getRetryState(packetHash), third);

    // A valid operation still succeeds after the failed transaction.
    const fourth = outbox.scheduleRetry(
      packetHash,
      null,
      third.nextAttemptAt,
      0,
    );

    assert.deepEqual(fourth, {
      attempts: 4,
      nextAttemptAt: third.nextAttemptAt + 4_000,
    });

    console.log("PASS: failed scheduling rolls back and the queue remains usable.");

    const unknownHash = "f".repeat(64);
    assert.notEqual(packetHash, unknownHash);

    assert.throws(
      () => outbox!.scheduleRetry(unknownHash, null, now, 0),
      /Cannot retry an unknown or completed packet/,
    );
    assert.equal(outbox.getRetryState(unknownHash), null);

    console.log("PASS: unknown packets cannot receive retry schedules.");

    outbox.markCompleted(packetHash, {
      packetHash,
      repeated: false,
      outcome: {
        status: "SETTLED",
        transactionId: "123",
      },
    });

    assert.throws(
      () => outbox!.scheduleRetry(packetHash, null, now, 0),
      /Cannot retry an unknown or completed packet/,
    );
    assert.deepEqual(outbox.getRetryState(packetHash), fourth);

    outbox.close();
    outbox = undefined;
    outbox = new BridgeOutbox(directory);

    assert.equal(
      outbox.listPending(100, fourth.nextAttemptAt + 1).length,
      0,
    );
    assert.equal(
      outbox.getCompleted(packetHash)?.outcome.status,
      "SETTLED",
    );

    console.log("PASS: completed packets stay excluded after their retry time.");
  } finally {
    try {
      outbox?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    console.log("Temporary retry outbox removed.");
  }
}

try {
  await checkOutboxRetries();
} catch (error) {
  console.error("Outbox retry check failed:", error);
  process.exitCode = 1;
}