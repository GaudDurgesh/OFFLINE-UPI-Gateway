import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { generateBridgeKey } from "../crypto/bridge-keys.js";
import { validatePacket } from "../domain/packet.js";
import { createGatewayClient } from "../bridge/gateway-client.js";

async function checkGatewayClient() {
  const apiKey = generateBridgeKey();

  const packet = {
    packetId: randomUUID(),
    ttl: 5,
    createdAt: Date.now(),
    ciphertext: Buffer.alloc(285, 1).toString("base64"),
  };

  const validated = validatePacket(packet);
  assert.ok(validated.ok);

  const validResponse = {
    packetHash: validated.packetHash,
    repeated: false,
    outcome: {
      status: "SETTLED",
      transactionId: "123",
    },
  };

  type Behavior = {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    hang?: boolean;
    disconnect?: boolean;
  };

  let behavior: Behavior = {};

  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    authorization: string | undefined;
    body: string;
  }> = [];

  const server = createServer((req, res) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });

    req.on("end", () => {
      requests.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        body,
      });

      if (behavior.disconnect) {
        res.destroy();
        return;
      }

      if (behavior.hang) {
        return;
      }

      res.writeHead(behavior.status ?? 200, {
        "Content-Type": "application/json",
        ...behavior.headers,
      });

      res.end(behavior.body ?? JSON.stringify(validResponse));
    });

    req.on("error", () => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const gatewayOrigin = `http://127.0.0.1:${address.port}`;

    const deliver = createGatewayClient({
      gatewayOrigin,
      apiKey,
      timeoutMs: 2_000,
    });

    const first = await deliver(packet);

    assert.equal(first.status, "COMPLETED");
    if (first.status === "COMPLETED") {
      assert.deepEqual(first.response, validResponse);
    }

    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.path, "/api/bridge/ingest");
    assert.equal(requests[0]?.authorization, `Bearer ${apiKey}`);
    assert.deepEqual(JSON.parse(requests[0]!.body), packet);

    console.log("PASS: authenticated delivery preserves the packet.");

    for (const status of ["INVALID", "REJECTED"]) {
      behavior = {
        body: JSON.stringify({
          ...validResponse,
          outcome: { status, reason: "TEST_REASON" },
        }),
      };

      const result = await deliver(packet);
      assert.equal(result.status, "COMPLETED");

      if (result.status === "COMPLETED") {
        assert.equal(result.response.outcome.status, status);
      }
    }

    console.log("PASS: terminal payment failures complete delivery.");

    for (const status of [408, 429, 500, 503]) {
      behavior = {
        status,
        headers: { "Retry-After": "2" },
      };

      assert.deepEqual(await deliver(packet), {
        status: "RETRY",
        reason: "TEMPORARY_HTTP_FAILURE",
        retryAfter: "2",
      });
    }

    console.log("PASS: temporary HTTP failures retain retry guidance.");

    for (const status of [401, 403]) {
      behavior = { status };

      assert.deepEqual(await deliver(packet), {
        status: "PAUSED",
        reason: "AUTHENTICATION_FAILED",
        httpStatus: status,
      });
    }

    console.log("PASS: authentication failures pause delivery.");

    behavior = {
      status: 307,
      headers: { Location: `${gatewayOrigin}/redirect-target` },
    };

    const beforeRedirect = requests.length;

    assert.deepEqual(await deliver(packet), {
      status: "PAUSED",
      reason: "UNEXPECTED_HTTP_STATUS",
      httpStatus: 307,
    });

    assert.equal(requests.length, beforeRedirect + 1);

    console.log("PASS: redirects are not followed.");

    for (const badResponse of [
      { body: "not-json" },
      {
        body: JSON.stringify({
          ...validResponse,
          packetHash: "b".repeat(64),
        }),
      },
      {
        body: "<html>Unexpected response</html>",
        headers: { "Content-Type": "text/html" },
      },
    ]) {
      behavior = badResponse;

      assert.deepEqual(await deliver(packet), {
        status: "RETRY",
        reason: "INVALID_GATEWAY_RESPONSE",
        retryAfter: null,
      });
    }

    console.log("PASS: malformed and mismatched responses remain retryable.");

    behavior = {
      body: JSON.stringify({ padding: "x".repeat(20_000) }),
    };

    assert.deepEqual(await deliver(packet), {
      status: "RETRY",
      reason: "INVALID_GATEWAY_RESPONSE",
      retryAfter: null,
    });

    console.log("PASS: oversized responses rejected.");

    behavior = { disconnect: true };

    assert.deepEqual(await deliver(packet), {
      status: "RETRY",
      reason: "NETWORK_OR_TIMEOUT",
      retryAfter: null,
    });

    console.log("PASS: connection loss remains retryable.");

    behavior = { hang: true };

    const shortDelivery = createGatewayClient({
      gatewayOrigin,
      apiKey,
      timeoutMs: 100,
    });

    assert.deepEqual(await shortDelivery(packet), {
      status: "RETRY",
      reason: "NETWORK_OR_TIMEOUT",
      retryAfter: null,
    });

    console.log("PASS: a stalled request times out.");

    const beforeInvalid = requests.length;

    await assert.rejects(
      () => deliver({}),
      /Cannot deliver an invalid local packet/,
    );

    assert.throws(
      () => createGatewayClient({
        gatewayOrigin: "http://example.com",
        apiKey,
      }),
      /HTTPS gateway origin/,
    );

    assert.equal(requests.length, beforeInvalid);

    console.log("PASS: invalid local input blocked before sending.");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });

      server.closeAllConnections();
    });

    console.log("Temporary gateway server closed.");
  }
}

try {
  await checkGatewayClient();
} catch (error) {
  console.error("Gateway client check failed:", error);
  process.exitCode = 1;
}