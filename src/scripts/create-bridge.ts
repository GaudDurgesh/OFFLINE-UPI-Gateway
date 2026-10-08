import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  generateBridgeKey,
  hashBridgeKey,
} from "../crypto/bridge-keys.js";

async function createBridge() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This setup command is allowed only in development.");
  }

  const name = process.argv.slice(2).join(" ").trim() || "demo-bridge";

  if (name.length > 80) {
    throw new Error("Bridge name must not exceed 80 characters.");
  }

  const bridgeId = randomUUID();
  const apiKey = generateBridgeKey();
  const directory = resolve(process.cwd(), ".keys");
  const filename = `bridge-${bridgeId}.json`;

  await mkdir(directory, { recursive: true, mode: 0o700 });

  // Save the credential before activating it in the database.
  await writeFile(
    resolve(directory, filename),
    JSON.stringify({ bridgeId, name, apiKey }, null, 2),
    { flag: "wx", mode: 0o600 },
  );

  await pool.query(
    `INSERT INTO bridge_nodes (id, name, api_key_hash)
     VALUES ($1, $2, $3)`,
    [bridgeId, name, hashBridgeKey(apiKey)],
  );

  console.log("Bridge created successfully.");
  console.log(`Bridge ID: ${bridgeId}`);
  console.log(`Credential file: .keys/${filename}`);
}

try {
  await createBridge();
} catch (error) {
  console.error("Bridge creation failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}