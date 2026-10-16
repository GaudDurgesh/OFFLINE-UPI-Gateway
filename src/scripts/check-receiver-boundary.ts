import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import express from "express";
import { createReceiverBoundary } from "../bridge/receiver-boundary.js";

async function checkReceiverBoundary() {
  const expectedOrigin = "https://192.168.0.103:8787";
  const expectedHost = "192.168.0.103:8787";

  for (const invalid of [
    "http://192.168.0.103:8787",
    "https://0.0.0.0:8787",
    "https://example.com",
    "https://user:password@192.168.0.103:8787",
    "https://192.168.0.103:8787/path",
    "https://192.168.0.103:8787?query=1",
    "https://192.168.0.103:8787#fragment",
  ]) {
    assert.throws(() => createReceiverBoundary(invalid));
  }

  console.log("PASS: invalid receiver origin configurations are rejected.");

  const app = express();
  let handlerCalls = 0;

  app.use(createReceiverBoundary(expectedOrigin));
  app.use((_req, res) => {
    handlerCalls += 1;
    res.status(200).json({ status: "reached" });
  });

  const server = app.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const port = address.port;

    // Raw header pairs preserve duplicates for negative tests.
    function send(headers: string[]) {
      return new Promise<number>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            method: "GET",
            headers,
            setHost: false,
            agent: false,
          },
          (res) => {
            res.resume();
            res.on("error", reject);
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );

        req.on("error", reject);
        req.setTimeout(5_000, () => {
          req.destroy(new Error("Boundary check timed out."));
        });
        req.end();
      });
    }

    for (const headers of [
      [],
      ["Host", "untrusted.example"],
      ["Host", "192.168.0.103:9999"],
      ["Host", expectedHost, "Host", expectedHost],
      ["Host", expectedHost, "Host", "untrusted.example"],
    ]) {
      assert.equal(await send(headers), 400);
    }

    assert.equal(handlerCalls, 0);
    console.log("PASS: missing, wrong and duplicate Host headers are rejected.");

    for (const origin of [
      "null",
      "https://untrusted.example",
      "http://192.168.0.103:8787",
      "https://192.168.0.103:9999",
      "https://192.168.0.103:8787.untrusted.example",
    ]) {
      assert.equal(
        await send(["Host", expectedHost, "Origin", origin]),
        403,
      );
    }

    assert.equal(handlerCalls, 0);
    console.log("PASS: null and mismatched origins cannot reach handlers.");

    assert.equal(
      await send([
        "Host", expectedHost,
        "Origin", expectedOrigin,
        "Origin", expectedOrigin,
      ]),
      403,
    );

    assert.equal(handlerCalls, 0);
    console.log("PASS: duplicate Origin headers are rejected.");

    assert.equal(
      await send([
        "Host", "untrusted.example",
        "X-Forwarded-Host", expectedHost,
        "X-Forwarded-Proto", "https",
        "Origin", expectedOrigin,
      ]),
      400,
    );

    assert.equal(
      await send([
        "Host", expectedHost,
        "Origin", "https://untrusted.example",
        "X-Forwarded-Host", expectedHost,
      ]),
      403,
    );

    assert.equal(handlerCalls, 0);
    console.log("PASS: forwarded headers cannot bypass host or origin checks.");

    assert.equal(
      await send(["Host", expectedHost, "Origin", expectedOrigin]),
      200,
    );

    assert.equal(await send(["Host", expectedHost]), 200);
    assert.equal(handlerCalls, 2);
    console.log("PASS: matching origin and origin-free requests reach handlers.");
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
  await checkReceiverBoundary();
} catch (error) {
  console.error("Receiver boundary check failed:", error);
  process.exitCode = 1;
}