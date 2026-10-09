import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { errorHandler } from "../middleware/error-handler.js";

async function checkHttpErrors() {
  const app = express();
  const sensitiveMessage = "TEST_SECRET_MUST_NOT_APPEAR";

  // These routes exist only in this isolated test server.
  app.get("/temporary", (_req, _res, next) => {
    next(Object.assign(new Error(sensitiveMessage), {
      code: "57014",
    }));
  });

  app.get("/connection", (_req, _res, next) => {
    next(Object.assign(new Error(sensitiveMessage), {
      code: "ECONNRESET",
    }));
  });

  app.get("/unexpected", (_req, _res, next) => {
    next(new Error(sensitiveMessage));
  });

  app.get("/constraint", (_req, _res, next) => {
    next(Object.assign(new Error(sensitiveMessage), {
      code: "23505",
    }));
  });

  app.post("/json", express.json({ limit: "1kb" }), (_req, res) => {
    res.json({ ok: true });
  });

  app.use(errorHandler);

  const server = app.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function check(
      path: string,
      status: number,
      error: string,
      options?: RequestInit,
    ) {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: AbortSignal.timeout(5000),
      });

      const body = await response.text();

      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(body), { error });
      assert.equal(body.includes(sensitiveMessage), false);

      if (status === 503) {
        assert.equal(response.headers.get("retry-after"), "2");
        assert.equal(response.headers.get("cache-control"), "no-store");
      } else {
        assert.equal(response.headers.get("retry-after"), null);
      }
    }

    await check("/temporary", 503, "SERVICE_UNAVAILABLE");
    await check("/connection", 503, "SERVICE_UNAVAILABLE");
    console.log("PASS: recognized temporary failures return retryable 503.");

    await check("/unexpected", 500, "INTERNAL_ERROR");
    await check("/constraint", 500, "INTERNAL_ERROR");
    console.log("PASS: unexpected and constraint errors remain 500.");

    await check("/json", 400, "INVALID_JSON", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"broken":',
    });

    await check("/json", 413, "PAYLOAD_TOO_LARGE", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2048) }),
    });

    console.log("PASS: malformed and oversized JSON retain correct responses.");
    console.log("PASS: responses contain no internal error details.");
  } finally {
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
  await checkHttpErrors();
} catch (error) {
  console.error("HTTP error check failed:", error);
  process.exitCode = 1;
}