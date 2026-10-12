import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BridgeOutbox,
  COMPLETED_RETENTION_MS,
} from "../bridge/outbox.js";

function runResult(directory: string, args: string[]) {
  return new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", resolve("src/scripts/bridge-result.ts"), ...args],
      {
        env: { ...process.env, BRIDGE_DATA_DIR: directory },
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(new Error("Result command could not finish."));
          return;
        }

        resolveResult({
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function checkBridgeResult() {
  const root = await mkdtemp(join(tmpdir(), "bridge-result-check-"));
  let outbox: BridgeOutbox | undefined;

  try {
    outbox = new BridgeOutbox(root);
    const now = Date.now();
    const unknownHash = "0".repeat(64);

    const packet = {
      packetId: randomUUID(),
      ttl: 5,
      createdAt: now,
      ciphertext: Buffer.alloc(285, 41).toString("base64"),
    };

    const hash = outbox.enqueue(packet).packetHash;

    assert.deepEqual(outbox.getPacketStatus(unknownHash, now), {
      packetHash: unknownHash,
      deliveryStatus: "NOT_FOUND",
      response: null,
      retry: null,
      pause: null,
    });

    assert.deepEqual(outbox.getPacketStatus(hash, now), {
      packetHash: hash,
      deliveryStatus: "PENDING",
      response: null,
      retry: null,
      pause: null,
    });

    const pendingCli = await runResult(root, [hash]);
    assert.equal(pendingCli.code, 0);
    assert.equal(JSON.parse(pendingCli.stdout).deliveryStatus, "PENDING");

    console.log("PASS: lookup distinguishes unknown packets from pending delivery.");

    const retry = outbox.scheduleRetry(hash, "60", now, 0);

    assert.equal(
      outbox.getPacketStatus(hash, retry.nextAttemptAt - 1).deliveryStatus,
      "RETRY_SCHEDULED",
    );

    const due = outbox.getPacketStatus(hash, retry.nextAttemptAt);
    assert.equal(due.deliveryStatus, "PENDING");
    assert.deepEqual(due.retry, retry);

    console.log("PASS: scheduled retry becomes pending exactly at its due time.");

    const pause = {
      reason: "AUTHENTICATION_FAILED" as const,
      httpStatus: 401,
    };

    outbox.pauseDelivery(pause);

    const paused = outbox.getPacketStatus(hash, now);
    assert.equal(paused.deliveryStatus, "PAUSED");
    assert.deepEqual(paused.pause, pause);
    assert.deepEqual(paused.retry, retry);

    assert.equal(
      outbox.getPacketStatus(unknownHash, now).deliveryStatus,
      "NOT_FOUND",
    );

    outbox.resumeDelivery();

    assert.equal(
      outbox.getPacketStatus(hash, now).deliveryStatus,
      "RETRY_SCHEDULED",
    );

    console.log("PASS: pause takes priority over retry and resume restores scheduling.");

    const settled = {
      packetHash: hash,
      repeated: false,
      outcome: {
        status: "SETTLED",
        transactionId: "123",
      },
    };

    outbox.markCompleted(hash, settled);
    outbox.pauseDelivery(pause);

    assert.deepEqual(outbox.getPacketStatus(hash, now), {
      packetHash: hash,
      deliveryStatus: "COMPLETED",
      response: settled,
      retry: null,
      pause: null,
    });

    console.log("PASS: stored settlement takes priority over retry and queue pause.");

    const rejectedPacket = {
      ...packet,
      packetId: randomUUID(),
      ciphertext: Buffer.alloc(285, 42).toString("base64"),
    };

    const rejectedHash = outbox.enqueue(rejectedPacket).packetHash;
    const rejected = {
      packetHash: rejectedHash,
      repeated: false,
      outcome: {
        status: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
      },
    };

    outbox.markCompleted(rejectedHash, rejected);

    const rejectedStatus = outbox.getPacketStatus(rejectedHash, now);
    assert.equal(rejectedStatus.deliveryStatus, "COMPLETED");
    assert.deepEqual(rejectedStatus.response, rejected);

    console.log("PASS: completed delivery preserves rejection instead of claiming settlement.");

    outbox.close();
    outbox = new BridgeOutbox(root);

    assert.deepEqual(outbox.getPacketStatus(hash).response, settled);
    assert.deepEqual(outbox.getPacketStatus(rejectedHash).response, rejected);

    console.log("PASS: stored delivery results survive reopening.");

    const settledCli = await runResult(root, [hash]);
    const rejectedCli = await runResult(root, [rejectedHash]);
    const missingCli = await runResult(root, [unknownHash]);

    assert.equal(settledCli.code, 0);
    assert.deepEqual(JSON.parse(settledCli.stdout).response, settled);

    assert.equal(rejectedCli.code, 0);
    assert.deepEqual(JSON.parse(rejectedCli.stdout).response, rejected);

    assert.equal(missingCli.code, 2);
    assert.equal(JSON.parse(missingCli.stdout).deliveryStatus, "NOT_FOUND");

    for (const args of [[], ["invalid"], [hash, hash]]) {
      const invalid = await runResult(root, args);
      assert.equal(invalid.code, 1);
    }

    for (const result of [pendingCli, settledCli, rejectedCli, missingCli]) {
      assert.equal(result.stdout.includes(packet.ciphertext), false);
      assert.equal(result.stderr.includes(packet.ciphertext), false);
      assert.equal(result.stdout.includes(rejectedPacket.ciphertext), false);
      assert.equal(result.stderr.includes(rejectedPacket.ciphertext), false);
    }

    console.log("PASS: CLI exit codes distinguish found, missing, and invalid input without ciphertext.");

    for (const invalidHash of ["", "abc", "A".repeat(64)]) {
      assert.throws(() => outbox!.getPacketStatus(invalidHash));
    }

    for (const invalidClock of [-1, 1.5, NaN, Infinity]) {
      assert.throws(() => outbox!.getPacketStatus(hash, invalidClock));
    }

    assert.deepEqual(outbox.getPacketStatus(hash).response, settled);

    console.log("PASS: invalid lookup arguments leave stored results unchanged.");

    outbox.resumeDelivery();

    assert.equal(
      outbox.pruneCompleted(
        100,
        Date.now() + COMPLETED_RETENTION_MS + 1_000,
      ),
      2,
    );

    assert.deepEqual(outbox.getPacketStatus(hash), {
      packetHash: hash,
      deliveryStatus: "NOT_FOUND",
      response: null,
      retry: null,
      pause: null,
    });

    const prunedCli = await runResult(root, [hash]);
    assert.equal(prunedCli.code, 2);
    assert.equal(JSON.parse(prunedCli.stdout).deliveryStatus, "NOT_FOUND");

    console.log("PASS: pruned results report not found rather than payment failure.");
  } finally {
    try {
      outbox?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    console.log("Temporary result queue removed.");
  }
}

try {
  await checkBridgeResult();
} catch (error) {
  console.error("Bridge result check failed:", error);
  process.exitCode = 1;
}