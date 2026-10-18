import assert from "node:assert/strict";
import express from "express";
import {
  createGatewayProtection,
  type ProtectionMode,
  type ProtectionResult,
} from "../middleware/gateway-protection.js";

async function checkProtection() {
  let mode: ProtectionMode = "OFF";
  let outcome: ProtectionResult = "ALLOW";
  let throwError = false;
  let checks = 0;
  let handled = 0;

  const logs: string[] = [];
  const originalWarn = console.warn;

  const app = express();

  app.use((_req, res, next) => {
    res.locals.requestId = "protection-test";
    next();
  });

  app.use((req, res, next) => {
    const middleware = createGatewayProtection(mode, async () => {
      checks++;

      if (throwError) {
        throw new Error("SECRET_INTERNAL_ERROR");
      }

      return outcome;
    });

    return middleware(req, res, next);
  });

  app.get("/test", (_req, res) => {
    handled++;
    res.json({ status: "ok" });
  });

  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/test`;

    console.warn = (...values: unknown[]) => {
      logs.push(values.map(String).join(" "));
    };

    async function request() {
      const response = await fetch(url, {
        headers: { Authorization: "Bearer SECRET_TEST_TOKEN" },
        signal: AbortSignal.timeout(3_000),
      });

      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: await response.json(),
      };
    }

    assert.equal((await request()).status, 200);
    assert.equal(checks, 0);
    assert.equal(handled, 1);
    console.log("PASS: OFF skips the protection check.");

    mode = "LIVE";
    assert.equal((await request()).status, 200);
    assert.equal(checks, 1);
    assert.equal(handled, 2);
    console.log("PASS: LIVE allows approved requests.");

    outcome = "DENY";
    assert.deepEqual(await request(), {
      status: 403,
      retryAfter: null,
      body: { error: "REQUEST_BLOCKED" },
    });
    assert.equal(handled, 2);
    console.log("PASS: LIVE denial never reaches the handler.");

    outcome = "ERROR";

    for (const shouldThrow of [false, true]) {
      throwError = shouldThrow;

      assert.deepEqual(await request(), {
        status: 503,
        retryAfter: "2",
        body: { error: "PROTECTION_UNAVAILABLE" },
      });
    }

    assert.equal(handled, 2);
    console.log("PASS: errors and exceptions return retryable 503.");

    mode = "DRY_RUN";
    throwError = false;

    for (const result of ["ALLOW", "DENY", "ERROR"] as const) {
      outcome = result;
      assert.equal((await request()).status, 200);
    }

    throwError = true;
    assert.equal((await request()).status, 200);
    assert.equal(handled, 6);
    console.log("PASS: DRY_RUN continues after every decision or exception.");

    const captured = logs.join("\n");
    assert.equal(captured.includes("SECRET_TEST_TOKEN"), false);
    assert.equal(captured.includes("SECRET_INTERNAL_ERROR"), false);
    assert.ok(captured.includes("gateway_protection_decision"));

    for (const line of logs) {
      const entry = JSON.parse(line);
      assert.equal(entry.requestId, "protection-test");
      assert.deepEqual(
        Object.keys(entry).sort(),
        ["event", "mode", "requestId", "result"],
      );
    }

    console.log("PASS: logs contain only safe decision metadata.");
  } finally {
    console.warn = originalWarn;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });

      server.closeAllConnections();
    });
  }
}

try {
  await checkProtection();
} catch (error) {
  console.error("Gateway protection check failed:", error);
  process.exitCode = 1;
}