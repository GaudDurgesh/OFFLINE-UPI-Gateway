import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeOutbox } from "../bridge/outbox.js";
import { createDeliveryWorker } from "../bridge/delivery-worker.js";
import type { DeliveryAttempt } from "../bridge/gateway-client.js";
import {
  validatePacket,
  type MeshPacket,
} from "../domain/packet.js";

function makePacket(seed: number): MeshPacket {
  return {
    packetId: randomUUID(),
    ttl: 5,
    createdAt: Date.now(),
    ciphertext: Buffer.alloc(285, seed).toString("base64"),
  };
}

function completed(packet: MeshPacket): DeliveryAttempt {
  const validated = validatePacket(packet);
  assert.ok(validated.ok);

  return {
    status: "COMPLETED",
    response: {
      packetHash: validated.packetHash,
      repeated: false,
      outcome: {
        status: "SETTLED",
        transactionId: "123",
      },
    },
  };
}

async function checkDeliveryWorker() {
  const directory = await mkdtemp(
    join(tmpdir(), "gateway-worker-check-"),
  );

  let outbox: BridgeOutbox | undefined;

  try {
    outbox = new BridgeOutbox(directory);

    let now = Date.UTC(2026, 9, 10, 12, 0, 0);
    let calls = 0;

    let handler: (packet: MeshPacket) => Promise<DeliveryAttempt> =
      async () => ({
        status: "RETRY",
        reason: "NETWORK_OR_TIMEOUT",
        retryAfter: null,
      });

    const newWorker = () => createDeliveryWorker(
      outbox!,
      async (packet) => {
        calls += 1;
        return handler(packet);
      },
      { now: () => now, random: () => 0 },
    );

    let worker = newWorker();
    const first = outbox.enqueue(makePacket(1));

    assert.equal((await worker.runOnce()).status, "RETRY");
    assert.deepEqual(outbox.getRetryState(first.packetHash), {
      attempts: 1,
      nextAttemptAt: now + 500,
    });

    assert.equal((await worker.runOnce()).status, "IDLE");
    assert.equal(calls, 1);

    console.log("PASS: retry is saved and early delivery is prevented.");

    now += 500;
    handler = async (packet) => completed(packet);

    assert.equal((await worker.runOnce()).status, "COMPLETED");
    assert.equal(
      outbox.getCompleted(first.packetHash)?.outcome.status,
      "SETTLED",
    );

    const callsAfterCompletion = calls;
    assert.equal((await worker.runOnce()).status, "IDLE");
    assert.equal(calls, callsAfterCompletion);

    console.log("PASS: successful delivery is saved and not sent again.");

    const second = outbox.enqueue(makePacket(2));

    handler = async () => ({
      status: "PAUSED",
      reason: "AUTHENTICATION_FAILED",
      httpStatus: 401,
    });

    assert.equal((await worker.runOnce()).status, "PAUSED");
    assert.equal(outbox.getCompleted(second.packetHash), null);
    assert.deepEqual(outbox.getDeliveryPause(), {
      reason: "AUTHENTICATION_FAILED",
      httpStatus: 401,
    });

    const callsAtPause = calls;
    assert.equal((await worker.runOnce()).status, "PAUSED");
    assert.equal(calls, callsAtPause);

    console.log("PASS: authentication failure pauses further sending.");

    outbox.close();
    outbox = undefined;
    outbox = new BridgeOutbox(directory);
    worker = newWorker();

    assert.equal((await worker.runOnce()).status, "PAUSED");
    assert.equal(calls, callsAtPause);
    assert.equal(outbox.listPending(100, now).length, 1);

    console.log("PASS: pause and pending packet survive reopening.");

    outbox.resumeDelivery();
    handler = async (packet) => completed(packet);

    assert.equal((await worker.runOnce()).status, "COMPLETED");
    assert.equal(outbox.getDeliveryPause(), null);
    assert.ok(outbox.getCompleted(second.packetHash));

    console.log("PASS: explicit resume allows pending delivery.");

    outbox.enqueue(makePacket(3));

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    handler = async (packet) => {
      await barrier;
      return completed(packet);
    };

    const callsBeforeOverlap = calls;
    const active = worker.runOnce();

    try {
      assert.equal((await worker.runOnce()).status, "BUSY");
      assert.equal(calls, callsBeforeOverlap + 1);
    } finally {
      release();
      assert.equal((await active).status, "COMPLETED");
    }

    console.log("PASS: overlapping calls send only one packet.");

    const fourth = outbox.enqueue(makePacket(4));

    handler = async () => {
      throw new Error("Simulated sender failure");
    };

    await assert.rejects(
      () => worker.runOnce(),
      /Simulated sender failure/,
    );

    assert.equal(outbox.getCompleted(fourth.packetHash), null);
    assert.equal(outbox.getRetryState(fourth.packetHash), null);
    assert.equal(outbox.listPending(100, now).length, 1);

    console.log("PASS: unexpected sender errors preserve pending work.");

    handler = async (packet) => completed(packet);

    assert.equal((await worker.runOnce()).status, "COMPLETED");
    assert.equal((await worker.runOnce()).status, "IDLE");

    console.log("PASS: worker capacity recovers after an exception.");
  } finally {
    try {
      outbox?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    console.log("Temporary worker outbox removed.");
  }
}

try {
  await checkDeliveryWorker();
} catch (error) {
  console.error("Delivery worker check failed:", error);
  process.exitCode = 1;
}