import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import {
  generateBridgeKey,
  hashBridgeKey,
} from "../crypto/bridge-keys.js";

async function setupCiHttp() {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.CI, "true");
  assert.equal(config.NODE_ENV, "development");

  const adminUrl = new URL(config.DATABASE_URL);

  // Restrict this helper to our disposable local CI database.
  assert.equal(adminUrl.hostname, "127.0.0.1");
  assert.equal(adminUrl.port, "5432");
  assert.equal(adminUrl.pathname, "/gateway_ci");
  assert.equal(adminUrl.username, "setup_admin");
  assert.equal(adminUrl.searchParams.get("sslmode"), "disable");

  const result = await pool.query(
    `SELECT rolcanlogin, rolsuper, rolcreatedb,
            rolcreaterole, rolreplication, rolbypassrls
     FROM pg_roles
     WHERE rolname = 'gateway_runtime'`,
  );

  assert.equal(result.rows.length, 1);

  for (const flag of [
    "rolcanlogin",
    "rolsuper",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
    "rolbypassrls",
  ]) {
    assert.equal(result.rows[0][flag], false);
  }

  const password = randomBytes(32).toString("hex");
  assert.match(password, /^[0-9a-f]{64}$/);

  const runtimeUrl = new URL(adminUrl);
  runtimeUrl.username = "gateway_runtime";
  runtimeUrl.password = password;

  const bridgeId = randomUUID();
  const apiKey = generateBridgeKey();

  await mkdir(".keys", { recursive: true, mode: 0o700 });

  await writeFile(
    ".env.ci.runtime",
    `DATABASE_URL=${JSON.stringify(runtimeUrl.toString())}\n`,
    { flag: "wx", mode: 0o600 },
  );

  await writeFile(
    ".keys/ci-bridge.json",
    JSON.stringify({ bridgeId, name: "ci-bridge", apiKey }, null, 2),
    { flag: "wx", mode: 0o600 },
  );

  await withTransaction(async (client) => {
    // The generated password contains only hexadecimal characters.
    await client.query(
      `ALTER ROLE gateway_runtime LOGIN PASSWORD '${password}'`,
    );

    await client.query(
      `INSERT INTO bridge_nodes (id, name, api_key_hash)
       VALUES ($1, $2, $3)`,
      [bridgeId, "ci-bridge", hashBridgeKey(apiKey)],
    );
  });

  console.log("CI runtime login and bridge credential prepared.");
}

try {
  await setupCiHttp();
} catch {
  console.error("CI HTTP setup failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}