import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BridgeOutbox,
  MAX_STORED_PACKETS,
  OutboxCapacityError,
} from "../bridge/outbox.js";
import {
  validatePacket,
  type MeshPacket,
} from "../domain/packet.js";

function makePacket(seed: number): MeshPacket {
  const bytes = Buffer.alloc(285);
  bytes.writeUInt32BE(seed);

  return {
    packetId: randomUUID(),
    ttl: 5,
    createdAt: Date.now(),
    ciphertext: bytes.toString("base64"),
  };
}

function runEnqueue(directory: string, filename: string) {
  return new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolveResult) => {
    execFile(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/scripts/bridge-enqueue.ts"),
        filename,
      ],
      {
        env: { ...process.env, BRIDGE_DATA_DIR: directory },
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolveResult({
          code: error
            ? typeof error.code === "number"
              ? error.code
              : -1
            : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function checkCapacity() {
  assert.equal(MAX_STORED_PACKETS, 10_000);

  const root = await mkdtemp(join(tmpdir(), "outbox-capacity-check-"));
  const directory = join(root, "queue");
  const knownPacket = makePacket(0);
  const known = validatePacket(knownPacket);
  assert.ok(known.ok);

  try {
    // Create the schema using the real outbox.
    const initial = new BridgeOutbox(directory);
    initial.close();

    // Populate only this temporary test database.
    // Leave exactly one slot for the real enqueue operations.
    const fixtureDatabase = new DatabaseSync(
      join(directory, "outbox.sqlite"),
    );

    try {
      fixtureDatabase.exec("BEGIN IMMEDIATE");

      try {
        const insert = fixtureDatabase.prepare(`
          INSERT INTO outbox (packet_hash, packet_json, queued_at)
          VALUES (?, ?, ?)
        `);

        for (let index = 0; index < MAX_STORED_PACKETS - 1; index++) {
          const packet = index === 0 ? knownPacket : makePacket(index);
          const validated = validatePacket(packet);
          assert.ok(validated.ok);

          insert.run(
            validated.packetHash,
            JSON.stringify(validated.packet),
            index,
          );
        }

        fixtureDatabase.exec("COMMIT");
      } catch (error) {
        fixtureDatabase.exec("ROLLBACK");
        throw error;
      }
    } finally {
      fixtureDatabase.close();
    }

    const outbox = new BridgeOutbox(directory);

    try {
      assert.equal(outbox.getSummary().total, MAX_STORED_PACKETS - 1);

      const firstCandidate = makePacket(MAX_STORED_PACKETS);
      const secondCandidate = makePacket(MAX_STORED_PACKETS + 1);

      const firstFile = join(root, "first.json");
      const secondFile = join(root, "second.json");

      await writeFile(firstFile, JSON.stringify(firstCandidate));
      await writeFile(secondFile, JSON.stringify(secondCandidate));

      // Both processes target the same remaining slot.
      const attempts = await Promise.all([
        runEnqueue(directory, firstFile),
        runEnqueue(directory, secondFile),
      ]);

      assert.deepEqual(
        attempts.map((attempt) => attempt.code).sort((a, b) => a - b),
        [0, 4],
      );

      assert.equal(outbox.getSummary().total, MAX_STORED_PACKETS);

      const winner = attempts.find((attempt) => attempt.code === 0)!;
      const loser = attempts.find((attempt) => attempt.code === 4)!;

      assert.equal(JSON.parse(winner.stdout).event, "packet_queued");

      assert.deepEqual(JSON.parse(loser.stderr), {
        event: "outbox_capacity_reached",
        error: "OUTBOX_FULL",
      });

      // Confirm the winning packet exists and the rejected one does not.
      const firstValidation = validatePacket(firstCandidate);
      const secondValidation = validatePacket(secondCandidate);
      assert.ok(firstValidation.ok);
      assert.ok(secondValidation.ok);

      const inspection = new DatabaseSync(
        join(directory, "outbox.sqlite"),
      );

      try {
        const find = inspection.prepare(
          "SELECT packet_hash FROM outbox WHERE packet_hash = ?",
        );

        assert.equal(
          Boolean(find.get(firstValidation.packetHash)),
          attempts[0]!.code === 0,
        );

        assert.equal(
          Boolean(find.get(secondValidation.packetHash)),
          attempts[1]!.code === 0,
        );
      } finally {
        inspection.close();
      }

      console.log(
        "PASS: competing enqueue processes admit exactly one final packet.",
      );
      console.log(
        "PASS: rejected CLI enqueue returns exit code four and OUTBOX_FULL.",
      );

      const extraPacket = makePacket(MAX_STORED_PACKETS + 2);
      const before = outbox.getSummary();

      assert.throws(
        () => outbox.enqueue(extraPacket),
        OutboxCapacityError,
      );

      assert.deepEqual(outbox.getSummary(), before);

      console.log(
        "PASS: capacity rejection leaves the existing queue unchanged.",
      );

      const retry = outbox.scheduleRetry(
        known.packetHash,
        "60",
        Date.now(),
        0,
      );

      const duplicate = outbox.enqueue({
        ...knownPacket,
        packetId: randomUUID(),
        ttl: 1,
      });

      assert.deepEqual(duplicate, {
        packetHash: known.packetHash,
        inserted: false,
      });

      assert.deepEqual(outbox.getRetryState(known.packetHash), retry);

      const stored = outbox
        .listPending(100, retry.nextAttemptAt)
        .find((entry) => entry.packetHash === known.packetHash);

      assert.ok(stored);
      assert.deepEqual(stored.packet, knownPacket);

      console.log(
        "PASS: duplicates at capacity preserve the original packet and retry.",
      );

      const outcome = {
        packetHash: known.packetHash,
        repeated: false,
        outcome: {
          status: "SETTLED",
          transactionId: "123",
        },
      };

      outbox.markCompleted(known.packetHash, outcome);

      assert.deepEqual(outbox.getCompleted(known.packetHash), outcome);
      assert.equal(outbox.enqueue(knownPacket).inserted, false);

      assert.throws(
        () => outbox.enqueue(extraPacket),
        OutboxCapacityError,
      );

      assert.equal(outbox.getSummary().total, MAX_STORED_PACKETS);
      assert.equal(outbox.getSummary().completed, 1);

      console.log(
        "PASS: completion preserves duplicate detection without freeing capacity.",
      );
    } finally {
      outbox.close();
    }

    const reopened = new BridgeOutbox(directory);

    try {
      assert.equal(reopened.getSummary().total, MAX_STORED_PACKETS);
      assert.equal(reopened.getSummary().completed, 1);
      assert.equal(reopened.enqueue(knownPacket).inserted, false);

      assert.throws(
        () => reopened.enqueue(makePacket(MAX_STORED_PACKETS + 3)),
        OutboxCapacityError,
      );

      console.log(
        "PASS: capacity enforcement and duplicate detection survive reopening.",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    console.log("Temporary capacity queue and packet files removed.");
  }
}

try {
  await checkCapacity();
} catch (error) {
  console.error("Outbox capacity check failed:", error);
  process.exitCode = 1;
}