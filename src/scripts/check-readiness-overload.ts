import assert from "node:assert/strict";
import { once } from "node:events";
import { pool } from "../db/pool.js";

async function checkReadinessOverload() {
  const originalQuery = Object.getOwnPropertyDescriptor(pool, "query");

  let queryCount = 0;
  let failQuery = false;
  let releaseQuery!: () => void;
  let signalStarted!: () => void;

  const held = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });

  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });

  // Replace database access only inside this test process.
  Object.defineProperty(pool, "query", {
    configurable: true,
    writable: true,
    value: async () => {
      queryCount += 1;
      signalStarted();
      await held;

      if (failQuery) {
        throw new Error("Simulated database failure.");
      }

      return { rows: [], rowCount: 1 };
    },
  });

  let server: ReturnType<
    (typeof import("node:http"))["createServer"]
  > | undefined;

  let firstRequest: Promise<Response> | undefined;

  try {
    // App startup still requires the existing server key files.
    const { default: app } = await import("../app.js");

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    const get = (path: string) =>
      fetch(origin + path, {
        signal: AbortSignal.timeout(5_000),
      });

    firstRequest = get("/ready");
    // Attach a handler immediately, including on failure paths.
    void firstRequest.catch(() => {});
    await Promise.race([
      started,
      firstRequest.then(() => {
        throw new Error("Readiness returned before the held query started.");
      }),
    ]);

    for (const path of ["/ready", "/health"]) {
      const blocked = await get(path);
      assert.equal(blocked.status, 503);
      assert.equal(blocked.headers.get("retry-after"), "2");
      assert.equal((await blocked.json()).database, "check_busy");
    }

    assert.equal(queryCount, 1);
    console.log("PASS: ready and health share one database-check slot.");

    const live = await get("/live");
    assert.equal(live.status, 200);
    await live.json();
    assert.equal(queryCount, 1);
    console.log("PASS: liveness remains available without querying the database.");

    releaseQuery();

    const first = await firstRequest;
    assert.equal(first.status, 200);
    assert.equal((await first.json()).database, "connected");
    console.log("PASS: the active readiness check completes successfully.");

    failQuery = true;
    const failed = await get("/health");
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).database, "unavailable");

    failQuery = false;
    const recovered = await get("/ready");
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).database, "connected");
    assert.equal(queryCount, 3);
    console.log("PASS: database failure releases capacity for the next check.");
  } finally {
    releaseQuery();
    await firstRequest?.catch(() => {});

    try {
      if (server) {
        const activeServer = server;
        await new Promise<void>((resolve, reject) => {
          activeServer.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          activeServer.closeAllConnections();
        });
      }
    } finally {
      if (originalQuery) {
        Object.defineProperty(pool, "query", originalQuery);
      } else {
        Reflect.deleteProperty(pool, "query");
      }

      await pool.end();
    }
  }
}

try {
  await checkReadinessOverload();
} catch (error) {
  console.error("Readiness overload check failed:", error);
  process.exitCode = 1;
}