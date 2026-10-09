import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  generateBridgeKey,
  hashBridgeKey,
} from "../crypto/bridge-keys.js";

async function runCommand(
  script: string,
  bridgeId: string,
  expectedCode: number,
) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/scripts", script), bridgeId],
      {
        env: process.env,
        stdio: "ignore",
      },
    );

    child.once("error", reject);

    child.once("close", (code, signal) => {
      if (code === expectedCode && signal === null) {
        resolvePromise();
      } else {
        reject(new Error(
          `${script}: expected exit ${expectedCode}, received ${code ?? signal}`,
        ));
      }
    });
  });
}

async function checkLifecycle() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This check is development-only.");
  }

  const bridgeId = randomUUID();
  const originalKey = generateBridgeKey();
  const directory = resolve(".keys");
  const prefix = `bridge-${bridgeId}-rotation-`;

  await mkdir(directory, { recursive: true, mode: 0o700 });

  async function rotationFiles() {
    return (await readdir(directory))
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .sort();
  }

  async function authenticate(key: string, expectedStatus: number) {
    const response = await fetch(
      `http://127.0.0.1:${config.PORT}/api/bridge/me`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      },
    );

    const body = await response.json();
    assert.equal(response.status, expectedStatus);

    if (expectedStatus === 200) {
      assert.equal(body.bridgeId, bridgeId);
    } else {
      assert.deepEqual(body, { error: "UNAUTHORIZED" });
    }
  }

  try {
    await pool.query(
      `INSERT INTO bridge_nodes (id, name, api_key_hash)
       VALUES ($1, $2, $3)`,
      [bridgeId, "Temporary lifecycle test", hashBridgeKey(originalKey)],
    );

    await authenticate(originalKey, 200);
    console.log("PASS: original credential accepted.");

    await runCommand("rotate-bridge-key.ts", bridgeId, 0);

    const files = await rotationFiles();
    assert.equal(files.length, 1);

    const replacement = JSON.parse(
      await readFile(resolve(directory, files[0]!), "utf8"),
    );

    assert.equal(replacement.bridgeId, bridgeId);
    assert.equal(typeof replacement.apiKey, "string");
    assert.ok(replacement.apiKey !== originalKey);

    await authenticate(originalKey, 401);
    await authenticate(replacement.apiKey, 200);
    console.log("PASS: rotation replaces the key and preserves bridge identity.");

    await runCommand("revoke-bridge.ts", bridgeId, 0);
    await authenticate(replacement.apiKey, 401);
    console.log("PASS: revocation blocks the replacement credential.");

    await runCommand("revoke-bridge.ts", bridgeId, 0);
    await authenticate(replacement.apiKey, 401);
    console.log("PASS: repeated revocation remains safe.");

    await runCommand("rotate-bridge-key.ts", bridgeId, 1);

    assert.deepEqual(await rotationFiles(), files);
    await authenticate(replacement.apiKey, 401);

    const state = await pool.query(
      "SELECT status, api_key_hash FROM bridge_nodes WHERE id = $1",
      [bridgeId],
    );

    assert.equal(state.rows[0]?.status, "revoked");
    assert.ok(
      state.rows[0]?.api_key_hash === hashBridgeKey(replacement.apiKey),
    );

    console.log("PASS: revoked bridge rotation fails without changing its key.");
  } finally {
    // Delete the temporary bridge first, invalidating any remaining key.
    await pool.query(
      "DELETE FROM bridge_nodes WHERE id = $1",
      [bridgeId],
    );

    for (const filename of await rotationFiles()) {
      await unlink(resolve(directory, filename));
    }

    console.log("Temporary lifecycle bridge and credential files removed.");
  }
}

try {
  await checkLifecycle();
} catch {
  // Avoid printing assertion values that might contain credentials.
  console.error(
    "Bridge lifecycle check failed. Check server availability, rate limits, and the last completed stage.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}