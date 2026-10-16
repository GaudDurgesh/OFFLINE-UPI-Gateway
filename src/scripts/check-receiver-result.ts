import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeOutbox } from "../bridge/outbox.js";
import { createReceiverApp } from "../bridge/receiver-app.js";

async function checkReceiverResult() {
  const directory = await mkdtemp(join(tmpdir(), "receiver-result-"));
  const outbox = new BridgeOutbox(directory);
  const token = `mesh_receiver_${randomBytes(32).toString("hex")}`;
  let lookups = 0;

  const app = createReceiverApp(
    {
      enqueue(input) {
        return outbox.enqueue(input);
      },
      getPacketStatus(packetHash, nowMs) {
        lookups += 1;
        return outbox.getPacketStatus(packetHash, nowMs);
      },
    },
    token,
  );

  const server = createServer(app);

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    async function lookup(
      hash: string,
      authorization: string | null = `Bearer ${token}`,
    ) {
      const response = await fetch(`${origin}/packets/${hash}`, {
        headers: authorization ? { authorization } : {},
        signal: AbortSignal.timeout(5_000),
      });

      const text = await response.text();

      assert(!text.includes(token));
      assert(!text.includes("ciphertext"));

      return {
        status: response.status,
        body: JSON.parse(text),
        cacheControl: response.headers.get("cache-control"),
      };
    }

    function makePacket() {
      return {
        packetId: randomUUID(),
        ttl: 5,
        createdAt: Date.now(),
        ciphertext: randomBytes(300).toString("base64"),
      };
    }

    const packet = makePacket();
    const { packetHash } = outbox.enqueue(packet);

    for (const authorization of [
      null,
      "Bearer invalid",
      `Bearer mesh_receiver_${"00".repeat(32)}`,
    ]) {
      const result = await lookup(packetHash, authorization);
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, { error: "UNAUTHORIZED" });
    }

    assert.equal(lookups, 0);
    console.log("PASS: unauthorized requests cannot look up packet results.");

    for (const hash of ["invalid", "a".repeat(63), "A".repeat(64)]) {
      const result = await lookup(hash);
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: "INVALID_PACKET_HASH" });
    }

    assert.equal(lookups, 0);
    console.log("PASS: malformed packet hashes are rejected before lookup.");

    const missing = await lookup("f".repeat(64));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.deliveryStatus, "NOT_FOUND");
    assert.equal(missing.body.response, null);
    console.log("PASS: an unknown packet returns NOT_FOUND.");

    const pending = await lookup(packetHash);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.packetHash, packetHash);
    assert.equal(pending.body.deliveryStatus, "PENDING");
    assert.equal(pending.body.response, null);
    assert.equal(pending.cacheControl, "no-store");
    console.log("PASS: a queued packet remains pending without a settlement.");

    const settledResponse = {
      packetHash,
      repeated: false,
      outcome: {
        status: "SETTLED",
        transactionId: "281",
      },
    };

    outbox.markCompleted(packetHash, settledResponse);

    const settled = await lookup(packetHash);
    assert.equal(settled.status, 200);
    assert.equal(settled.body.deliveryStatus, "COMPLETED");
    assert.deepEqual(settled.body.response, settledResponse);
    console.log("PASS: completed delivery returns its stored settlement.");

    const rejectedPacket = makePacket();
    const rejected = outbox.enqueue(rejectedPacket);

    const rejectedResponse = {
      packetHash: rejected.packetHash,
      repeated: false,
      outcome: {
        status: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
      },
    };

    outbox.markCompleted(rejected.packetHash, rejectedResponse);

    const rejection = await lookup(rejected.packetHash);
    assert.equal(rejection.status, 200);
    assert.equal(rejection.body.deliveryStatus, "COMPLETED");
    assert.deepEqual(rejection.body.response, rejectedResponse);
    console.log("PASS: completed delivery preserves a rejected payment outcome.");

    const before = outbox.getSummary();
    await lookup(packetHash);
    await lookup(rejected.packetHash);
    assert.deepEqual(outbox.getSummary(), before);
    assert.equal(outbox.enqueue(packet).inserted, false);
    console.log("PASS: lookups preserve queue state and expose no token or ciphertext.");
  } finally {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    } finally {
      outbox.close();
      await rm(directory, { recursive: true, force: true });
      console.log("Temporary result server and queue removed.");
    }
  }
}

try {
  await checkReceiverResult();
} catch (error) {
  console.error("Receiver result check failed:", error);
  process.exitCode = 1;
}