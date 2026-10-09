import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import {
  generateBridgeKey,
  hashBridgeKey,
} from "../crypto/bridge-keys.js";

async function rotateBridgeKey() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This command is currently development-only.");
  }

  const args = process.argv.slice(2);

  if (args.length !== 1) {
    throw new Error("Exactly one bridge ID is required.");
  }

  const bridgeId = z.string().uuid().parse(args[0]).toLowerCase();
  const apiKey = generateBridgeKey();

  const directory = resolve(process.cwd(), ".keys");
  const filename = `bridge-${bridgeId}-rotation-${randomUUID()}.json`;

  await mkdir(directory, { recursive: true, mode: 0o700 });

  await withTransaction(async (client) => {
    const result = await client.query<{
      name: string;
      status: string;
    }>(
      `SELECT name, status
       FROM bridge_nodes
       WHERE id = $1
       FOR UPDATE`,
      [bridgeId],
    );

    const bridge = result.rows[0];

    if (!bridge || bridge.status !== "active") {
      throw new Error("Bridge must exist and be active.");
    }

    // Never overwrite the old credential.
    // Save the replacement before changing the database.
    await writeFile(
      resolve(directory, filename),
      JSON.stringify({
        bridgeId,
        name: bridge.name,
        apiKey,
      }, null, 2),
      { flag: "wx", mode: 0o600 },
    );

    console.log(`Candidate credential file: .keys/${filename}`);

    const updated = await client.query(
      `UPDATE bridge_nodes
       SET api_key_hash = $2
       WHERE id = $1 AND status = 'active'
       RETURNING id`,
      [bridgeId, hashBridgeKey(apiKey)],
    );

    if (updated.rows.length !== 1) {
      throw new Error("Bridge rotation did not update exactly one row.");
    }
  });

  console.log(`Bridge credential rotated: ${bridgeId}`);
  console.log(`Credential file: .keys/${filename}`);
}

try {
  await rotateBridgeKey();
} catch {
  console.error(
    "Rotation failed or its commit could not be confirmed. Keep any candidate credential file and verify which key works before retrying.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}