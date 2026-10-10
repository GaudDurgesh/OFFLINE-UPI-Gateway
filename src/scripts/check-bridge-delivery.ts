import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBridgeKey } from "../crypto/bridge-keys.js";
import { validatePacket } from "../domain/packet.js";
import { BridgeOutbox } from "../bridge/outbox.js";
import { createGatewayClient } from "../bridge/gateway-client.js";
import { createDeliveryWorker } from "../bridge/delivery-worker.js";

async function checkBridgeDelivery() {
  const directory = await mkdtemp(
    join(tmpdir(), "bridge-delivery-check-"),
  );

  const apiKey = generateBridgeKey();
  const receivedBodies: string[] = [];
  const processedHashes = new Set<string>();

  let dropFirstResponse = true;
  let outbox: BridgeOutbox | undefined;
  let now = Date.now();

  const server = createServer((req, res) => {
    if (
      req.method !== "POST" ||
      req.url !== "/api/bridge/ingest" ||
      req.headers.authorization !== `Bearer ${apiKey}`
    ) {
      req.resume();
      res.writeHead(401);
      res.end();
      return;
    }

    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const validated = validatePacket(JSON.parse(body));

        if (!validated.ok) {
          res.writeHead(400);
          res.end();
          return;
        }

        receivedBodies.push(body);

        const repeated = processedHashes.has(validated.packetHash);
        processedHashes.add(validated.packetHash);

        // Simulate processing successfully, then losing the response.
        if (dropFirstResponse) {
          dropFirstResponse = false;
          res.destroy();
          return;
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });

        res.end(JSON.stringify({
          packetHash: validated.packetHash,
          repeated,
          outcome: {
            status: "SETTLED",
            transactionId: "123",
          },
        }));
      } catch {
        res.writeHead(400);
        res.end();
      }
    });

    req.on("error", () => res.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const deliver = createGatewayClient({
      gatewayOrigin: `http://127.0.0.1:${address.port}`,
      apiKey,
      timeoutMs: 2_000,
    });

    outbox = new BridgeOutbox(directory);

    const packet = {
      packetId: randomUUID(),
      ttl: 5,
      createdAt: now,
      ciphertext: Buffer.alloc(285, 7).toString("base64"),
    };

    const { packetHash } = outbox.enqueue(packet);

    const newWorker = () => createDeliveryWorker(
      outbox!,
      deliver,
      { now: () => now, random: () => 0 },
    );

    let worker = newWorker();

    assert.equal((await worker.runOnce()).status, "RETRY");
    assert.equal(processedHashes.size, 1);
    assert.equal(outbox.getCompleted(packetHash), null);

    const retry = outbox.getRetryState(packetHash);
    assert.ok(retry);
    assert.equal(retry.attempts, 1);

    console.log("PASS: lost response keeps the processed packet retryable.");

    outbox.close();
    outbox = undefined;
    outbox = new BridgeOutbox(directory);
    worker = newWorker();

    assert.deepEqual(outbox.getRetryState(packetHash), retry);
    assert.equal(outbox.enqueue(packet).inserted, false);

    console.log("PASS: reopening preserves the packet and retry schedule.");

    assert.equal((await worker.runOnce()).status, "IDLE");
    assert.equal(receivedBodies.length, 1);

    console.log("PASS: reopening does not bypass the retry delay.");

    now = retry.nextAttemptAt;

    const result = await worker.runOnce();

    assert.equal(result.status, "COMPLETED");
    if (result.status === "COMPLETED") {
      assert.equal(result.response.repeated, true);
      assert.equal(result.response.packetHash, packetHash);
    }

    assert.equal(processedHashes.size, 1);
    assert.equal(receivedBodies.length, 2);
    assert.ok(outbox.getCompleted(packetHash));

    console.log("PASS: retry receives and stores the existing gateway outcome.");

    assert.equal(receivedBodies[0], receivedBodies[1]);
    assert.deepEqual(JSON.parse(receivedBodies[1]!), packet);

    console.log("PASS: retry sends exactly the same packet.");

    outbox.close();
    outbox = undefined;
    outbox = new BridgeOutbox(directory);
    worker = newWorker();

    assert.equal((await worker.runOnce()).status, "IDLE");
    assert.equal(receivedBodies.length, 2);
    assert.equal(
      outbox.getCompleted(packetHash)?.outcome.status,
      "SETTLED",
    );

    console.log("PASS: completed delivery stays completed after reopening.");
  } finally {
    try {
      outbox?.close();
    } finally {
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
            server.closeAllConnections();
          });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    console.log("Temporary delivery server and outbox removed.");
  }
}

try {
  await checkBridgeDelivery();
} catch (error) {
  console.error("Bridge delivery check failed:", error);
  process.exitCode = 1;
}