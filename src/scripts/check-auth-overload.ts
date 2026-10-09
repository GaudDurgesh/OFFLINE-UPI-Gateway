import assert from "node:assert/strict";
import { once } from "node:events";
import { mock } from "node:test";
import express from "express";
import { pool } from "../db/pool.js";
import { generateBridgeKey } from "../crypto/bridge-keys.js";
import { bridgeAuth } from "../middleware/bridge-auth.js";
import { requestId } from "../middleware/request-id.js";
import { errorHandler } from "../middleware/error-handler.js";

async function checkAuthOverload() {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  let markFull!: () => void;
  const full = new Promise<void>((resolve) => {
    markFull = resolve;
  });

  let queries = 0;

  // Mock applies only inside this test process.
  const queryMock = mock.method(pool, "query", async () => {
    queries += 1;

    if (queries === 4) {
      markFull();
    }

    await barrier;

    return {
      rows: [{
        id: "test-bridge",
        name: "Overload Test",
        status: "active",
      }],
    };
  });

  const app = express();
  app.use(requestId);

  app.get("/test", bridgeAuth, (_req, res) => {
    res.json({ ok: true });
  });

  app.use(errorHandler);

  const server = app.listen(0, "127.0.0.1");
  const pending: Promise<void>[] = [];
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  try {
    await once(server, "listening");

    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const url = `http://127.0.0.1:${address.port}/test`;
    const key = generateBridgeKey();

    async function request(expectedStatus: number) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });

      const body = await response.json();
      assert.equal(response.status, expectedStatus);

      if (expectedStatus === 503) {
        assert.deepEqual(body, { error: "SERVICE_BUSY" });
        assert.equal(response.headers.get("retry-after"), "1");
      } else {
        assert.deepEqual(body, { ok: true });
      }
    }

    for (let i = 0; i < 4; i++) {
      const attempt = request(200);
      // Attach rejection handling immediately while we wait for capacity.
      void attempt.catch(() => {});
      pending.push(attempt);
    }

    await Promise.race([
      full,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("Four authentication queries did not start.")),
          5000,
        );
      }),
    ]);

    clearTimeout(watchdog);

    await request(503);
    assert.equal(queries, 4);

    console.log("PASS: fifth authentication request returns 503 with Retry-After.");
    console.log("PASS: overloaded request never queries the database.");

    release();
    await Promise.all(pending);

    console.log("PASS: four active authentication requests finish successfully.");

    await request(200);
    assert.equal(queries, 5);

    console.log("PASS: authentication capacity recovers afterward.");
  } finally {
    clearTimeout(watchdog);
    release();
    await Promise.allSettled(pending);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });

    queryMock.mock.restore();
  }
}

try {
  await checkAuthOverload();
} catch (error) {
  console.error("Authentication overload check failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}