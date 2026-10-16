import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeOutbox, OutboxCapacityError } from "../bridge/outbox.js";
import { createReceiverApp } from "../bridge/receiver-app.js";

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "receiver-http-"));
  const outbox = new BridgeOutbox(directory);
  const token = `mesh_receiver_${randomBytes(32).toString("hex")}`;

  let forceFull = false;
  let forceFailure = false;

  const app = createReceiverApp({
    getPacketStatus(packetHash, nowMs) {
      return outbox.getPacketStatus(packetHash, nowMs);
    },
    enqueue(input) {
      if (forceFull) throw new OutboxCapacityError();
      if (forceFailure) throw new Error("PRIVATE_DATABASE_DETAIL");
      return outbox.enqueue(input);
    },
  }, token);

  const server = createServer(app);

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const origin = `http://127.0.0.1:${address.port}`;

    // Structurally valid storage fixture, not a real encrypted payment.
    const packet = {
      packetId: randomUUID(),
      ttl: 5,
      createdAt: Date.now(),
      ciphertext: randomBytes(300).toString("base64"),
    };

    async function post(
      body: string,
      authorization: string | null = `Bearer ${token}`,
      contentType = "application/json",
      extraHeaders: Record<string, string> = {},
    ) {
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        ...extraHeaders,
      };

      if (authorization !== null) {
        headers.Authorization = authorization;
      }

      const response = await fetch(`${origin}/packets`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5_000),
      });

      return {
        status: response.status,
        body: await response.json(),
        headers: response.headers,
      };
    }

    const health = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    console.log("PASS: health endpoint remains available.");

    for (const authorization of [
      null,
      "Bearer invalid",
      `Bearer mesh_receiver_${"00".repeat(32)}`,
    ]) {
      // Malformed JSON must not be parsed before authentication.
      const result = await post("{", authorization);
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, { error: "UNAUTHORIZED" });
    }

    assert.equal(outbox.getSummary().total, 0);
    console.log("PASS: unauthorized requests cannot change the queue.");

    const first = await post(JSON.stringify(packet));
    assert.equal(first.status, 202);
    assert.equal(first.body.status, "QUEUED");
    assert.match(first.body.packetHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(outbox.listPending()[0]?.packet, packet);
    console.log("PASS: authenticated packet is stored unchanged.");

    const duplicate = await post(JSON.stringify({
      ...packet,
      packetId: randomUUID(),
      ttl: 4,
    }));

    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.status, "ALREADY_KNOWN");
    assert.equal(duplicate.body.packetHash, first.body.packetHash);
    assert.equal(outbox.getSummary().total, 1);
    assert.deepEqual(outbox.listPending()[0]?.packet, packet);
    console.log("PASS: duplicate delivery preserves the original packet.");

    assert.equal((await post("{}")).status, 400);
    assert.equal((await post("{")).status, 400);
    assert.equal(
      (await post(JSON.stringify({ value: "x".repeat(17_000) }))).status,
      413,
    );
    assert.equal(outbox.getSummary().total, 1);
    console.log("PASS: invalid and oversized requests leave the queue unchanged.");

    assert.equal(
      (await post("{}", `Bearer ${token}`, "text/plain")).status,
      415,
    );
    assert.equal(
      (await post("{}", `Bearer ${token}`, "application/json", {
        "Content-Encoding": "gzip",
      })).status,
      415,
    );
    console.log("PASS: unsupported media and compression are rejected.");

    forceFull = true;
    const full = await post(JSON.stringify(packet));
    assert.equal(full.status, 503);
    assert.deepEqual(full.body, { error: "OUTBOX_FULL" });
    assert.equal(full.headers.get("retry-after"), "60");
    forceFull = false;
    console.log("PASS: full outbox returns a retryable response.");

    forceFailure = true;
    const failed = await post(JSON.stringify(packet));
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: "INTERNAL_ERROR" });
    assert.equal(JSON.stringify(failed.body).includes("PRIVATE_DATABASE_DETAIL"), false);
    forceFailure = false;
    console.log("PASS: storage failure exposes no internal details.");

    let limited = false;

    for (let attempt = 0; attempt < 65; attempt++) {
      const result = await post("{}", null);

      if (result.status === 429) {
        assert.deepEqual(result.body, { error: "RATE_LIMITED" });
        assert.ok(result.headers.get("retry-after"));
        limited = true;
        break;
      }

      assert.equal(result.status, 401);
    }

    assert.equal(limited, true);
    assert.equal(outbox.getSummary().total, 1);
    console.log("PASS: repeated requests reach the rate limit.");
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
      outbox.close();
      await rm(directory, { recursive: true, force: true });
      console.log("Temporary receiver server and queue removed.");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error("Receiver HTTP check failed:", error);
  process.exitCode = 1;
}