import assert from "node:assert/strict";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { isBridgeKey } from "../crypto/bridge-keys.js";

async function expectTimeout(
  label: string,
  request: string,
  minimumMs: number,
  deadlineMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    let response = "";
    let settled = false;

    const socket = net.createConnection({
      host: "127.0.0.1",
      port: config.PORT,
    });

    const deadline = setTimeout(() => {
      finish(new Error(`${label}: connection exceeded the test deadline.`));
    }, deadlineMs);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;

      clearTimeout(deadline);
      socket.destroy();

      if (error) reject(error);
      else resolve();
    }

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(request);
    });

    socket.on("data", (chunk: string) => {
      response += chunk;

      if (response.length > 16_384) {
        finish(new Error(`${label}: unexpected response size.`));
      }
    });

    socket.on("error", () => {
      finish(new Error(`${label}: socket connection failed.`));
    });

    socket.on("close", () => {
      if (settled) return;

      try {
        const elapsed = Date.now() - started;

        assert.match(response, /^HTTP\/1\.1 408\b/);
        assert.ok(
          elapsed >= minimumMs,
          `${label}: timeout occurred earlier than expected.`,
        );

        console.log(`PASS: ${label} rejected with 408 after ${elapsed} ms.`);
        finish();
      } catch {
        finish(new Error(`${label}: timeout response check failed.`));
      }
    });
  });
}

async function checkHttpTimeouts() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This check is development-only.");
  }

  const bridgeId = "1a83556f-c931-4d72-96ca-1217577fbbf5";
  const credential = JSON.parse(
    await readFile(`.keys/bridge-${bridgeId}.json`, "utf8"),
  );

  assert.equal(credential.bridgeId, bridgeId);
  assert.ok(isBridgeKey(credential.apiKey));

  // Confirm authentication works before testing an incomplete body.
  const preflight = await fetch(
    `http://127.0.0.1:${config.PORT}/api/bridge/me`,
    {
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );

  const identity = await preflight.json();
  assert.equal(preflight.status, 200);
  assert.equal(identity.bridgeId, bridgeId);

  await expectTimeout(
    "Incomplete headers",
    "GET /live HTTP/1.1\r\nHost: localhost\r\n",
    9_000,
    20_000,
  );

  await expectTimeout(
    "Incomplete body",
    [
      "POST /api/bridge/ingest HTTP/1.1",
      "Host: localhost",
      `Authorization: Bearer ${credential.apiKey}`,
      "Content-Type: application/json",
      "Content-Length: 2",
      "Connection: close",
      "",
      "{",
    ].join("\r\n"),
    29_000,
    40_000,
  );

  const health = await fetch(
    `http://127.0.0.1:${config.PORT}/live`,
    { signal: AbortSignal.timeout(5000) },
  );

  assert.equal(health.status, 200);
  await health.json();

  console.log("PASS: server remains responsive after both timeouts.");
}

try {
  await checkHttpTimeouts();
} catch {
  console.error(
    "HTTP timeout check failed. Check server availability, credentials, rate limits, and timeout configuration.",
  );
  process.exitCode = 1;
}