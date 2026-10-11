import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { generateDeviceKeyPair } from "../crypto/signature.js";
import { loadServerKeys } from "../crypto/server-keys.js";
import {
  generateBridgeKey,
  hashBridgeKey,
} from "../crypto/bridge-keys.js";
import { buildPacket } from "../services/build-packet.js";
import { BridgeOutbox } from "../bridge/outbox.js";
import type { MeshPacket } from "../domain/packet.js";

async function checkBridgeGateway() {
  assert.equal(
    config.NODE_ENV,
    "development",
    "This check requires the development environment.",
  );

  const origin = `http://127.0.0.1:${config.PORT}`;
  const ready = await fetch(`${origin}/ready`, {
    signal: AbortSignal.timeout(10_000),
  });

  await ready.text();
  assert.equal(ready.status, 200, "Start the gateway before this check.");

  const serverKeys = await loadServerKeys();
  const deviceKeys = generateDeviceKeyPair();

  const senderId = randomUUID();
  const receiverId = randomUUID();
  const deviceId = randomUUID();
  const bridgeId = randomUUID();
  const paymentId = randomUUID();
  const apiKey = generateBridgeKey();

  const root = await mkdtemp(join(tmpdir(), "bridge-gateway-check-"));
  const credentialFile = join(root, "credentials.json");
  const hashes = new Set<string>();

  let safeToCleanDatabase = true;
  let stage = "fixture setup";

  async function deliverFromQueue(
    directory: string,
    packet: MeshPacket,
  ) {
    const outbox = new BridgeOutbox(directory);

    try {
      const queued = outbox.enqueue(packet);
      hashes.add(queued.packetHash);
      assert.equal(outbox.getSummary().pending, 1);

      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("src/scripts/bridge-run.ts"),
          origin,
          credentialFile,
        ],
        {
          env: { ...process.env, BRIDGE_DATA_DIR: directory },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let output = "";
      let finished = false;
      let spawnFailed = false;

      const capture = (chunk: Buffer) => {
        output += chunk.toString("utf8");
      };

      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", () => {
        spawnFailed = true;
      });

      const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveClosed) => {
        child.once("close", (code, signal) => {
          finished = true;
          resolveClosed({ code, signal });
        });
      });

      try {
        const deadline = Date.now() + 60_000;

        while (true) {
          const completed = outbox.getCompleted(queued.packetHash);

          if (completed) {
            assert.equal(outbox.getSummary().pending, 0);
            return completed;
          }

          assert.equal(spawnFailed, false, "Runner could not start.");
          assert.equal(finished, false, "Runner exited before completion.");
          assert.ok(Date.now() < deadline, "Delivery timed out.");

          await sleep(100);
        }
      } finally {
        if (!finished) {
          child.kill("SIGTERM");
        }

        const deadline = Date.now() + 35_000;

        while (!finished && Date.now() < deadline) {
          await sleep(50);
        }

        if (!finished) {
          // A forced stop might leave an HTTP request active at the gateway.
          // Preserve database fixtures instead of racing that request.
          safeToCleanDatabase = false;
          child.kill("SIGKILL");
          await closed;
          throw new Error("Runner did not shut down gracefully.");
        }

        const exit = await closed;

        if (exit.code !== 0 || exit.signal !== null) {
          safeToCleanDatabase = false;
          throw new Error("Runner stopped abnormally.");
        }

        assert.equal(output.includes(apiKey), false);
        assert.equal(output.includes(packet.ciphertext), false);
      }
    } finally {
      outbox.close();
    }
  }

  try {
    await writeFile(
      credentialFile,
      JSON.stringify({ bridgeId, apiKey }),
      { flag: "wx", mode: 0o600 },
    );

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO accounts (id, vpa, name, balance_paise)
         VALUES
           ($1, $2, 'Bridge Test Sender', 50000),
           ($3, $4, 'Bridge Test Receiver', 0)`,
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
        [deviceId, senderId, deviceKeys.publicKey],
      );

      await client.query(
        `INSERT INTO bridge_nodes (id, name, api_key_hash)
         VALUES ($1, $2, $3)`,
        [bridgeId, "Temporary gateway check", hashBridgeKey(apiKey)],
      );
    });

    const packet = buildPacket(
      {
        version: 1,
        paymentId,
        deviceId,
        senderAccountId: senderId,
        receiverAccountId: receiverId,
        amountPaise: "10000",
        counter: "1",
        signedAt: Date.now(),
      },
      deviceKeys.privateKey,
      serverKeys.publicKey,
    );

    stage = "first delivery";
    const first = await deliverFromQueue(join(root, "first"), packet);

    assert.equal(first.repeated, false);
    assert.ok(first.outcome.status === "SETTLED");

    console.log(
      "PASS: runner delivers a signed, encrypted payment to the real gateway.",
    );

    stage = "repeated delivery";
    const repeated = await deliverFromQueue(join(root, "second"), packet);

    assert.equal(repeated.repeated, true);
    assert.equal(repeated.packetHash, first.packetHash);
    assert.deepEqual(repeated.outcome, first.outcome);

    console.log(
      "PASS: a fresh queue receives the existing settlement for the same packet.",
    );

    stage = "database verification";
    const accounts = await pool.query<{
      id: string;
      balance_paise: string;
    }>(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id IN ($1, $2)`,
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

    console.log("PASS: exactly ₹100 moved and the total ₹500 is preserved.");

    const ledger = await pool.query<{ id: string }>(
      `SELECT id FROM transactions
       WHERE sender_account_id IN ($1, $2)
          OR receiver_account_id IN ($1, $2)`,
      [senderId, receiverId],
    );

    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0]!.id, first.outcome.transactionId);

    console.log("PASS: both deliveries produced only one ledger row.");
    console.log(
      "PASS: both runners stopped cleanly without logging credentials or ciphertext.",
    );
  } catch {
    throw new Error(`Bridge gateway check failed during: ${stage}`);
  } finally {
    try {
      if (safeToCleanDatabase) {
        await withTransaction(async (client) => {
          await client.query(
            "DELETE FROM payment_intents WHERE device_id = $1",
            [deviceId],
          );

          await client.query(
            "DELETE FROM packets WHERE packet_hash = ANY($1::text[])",
            [[...hashes]],
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

          await client.query(
            "DELETE FROM bridge_nodes WHERE id = $1",
            [bridgeId],
          );
        });

        console.log("Temporary gateway test data removed.");
      } else {
        console.error(
          "Database fixtures retained after abnormal shutdown. " +
          `Sender: ${senderId}; receiver: ${receiverId}; ` +
          `device: ${deviceId}; bridge: ${bridgeId}`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

try {
  await checkBridgeGateway();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Bridge gateway check failed.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}