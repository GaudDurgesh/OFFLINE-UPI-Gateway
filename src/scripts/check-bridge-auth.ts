import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  generateBridgeKey,
  hashBridgeKey,
} from "../crypto/bridge-keys.js";

async function checkBridgeAuth() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This check is allowed only in development.");
  }

  const bridgeId = randomUUID();
  const apiKey = generateBridgeKey();
  const name = "Temporary Auth Test";
  const url = `http://127.0.0.1:${config.PORT}/api/bridge/me`;

  async function request(key?: string) {
    return fetch(url, {
      headers: key === undefined
        ? {}
        : { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
  }

  async function expectUnauthorized(key?: string) {
    const response = await request(key);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "UNAUTHORIZED",
    });
  }

  try {
    await pool.query(
      `INSERT INTO bridge_nodes (id, name, api_key_hash)
       VALUES ($1, $2, $3)`,
      [bridgeId, name, hashBridgeKey(apiKey)],
    );

    await expectUnauthorized();
    console.log("PASS: missing key rejected.");

    await expectUnauthorized("invalid-key");
    console.log("PASS: malformed key rejected.");

    await expectUnauthorized(generateBridgeKey());
    console.log("PASS: correctly formatted but unknown key rejected.");

    const validResponse = await request(apiKey);

    assert.equal(validResponse.status, 200);
    assert.deepEqual(await validResponse.json(), {
      bridgeId,
      name,
    });

    console.log("PASS: active bridge key accepted.");

    await pool.query(
      "UPDATE bridge_nodes SET status = 'revoked' WHERE id = $1",
      [bridgeId],
    );

    await expectUnauthorized(apiKey);
    console.log("PASS: revoked bridge key rejected.");
  } finally {
    await pool.query(
      "DELETE FROM bridge_nodes WHERE id = $1",
      [bridgeId],
    );

    console.log("Temporary bridge removed.");
  }
}

try {
  await checkBridgeAuth();
} catch (error) {
  console.error("Bridge authentication check failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}