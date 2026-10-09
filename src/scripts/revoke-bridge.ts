import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

async function revokeBridge() {
  if (config.NODE_ENV !== "development") {
    throw new Error("This command is currently development-only.");
  }

  const args = process.argv.slice(2);

  if (args.length !== 1) {
    throw new Error("Usage: npm run bridge:revoke -- <bridge-id>");
  }

  const parsed = z.string().uuid().safeParse(args[0]);

  if (!parsed.success) {
    throw new Error("Bridge ID must be a valid UUID.");
  }

  const bridgeId = parsed.data.toLowerCase();

  const result = await pool.query<{ id: string }>(
    `UPDATE bridge_nodes
     SET status = 'revoked'
     WHERE id = $1
     RETURNING id`,
    [bridgeId],
  );

  if (result.rows.length === 0) {
    console.log("Bridge not found. No bridge was changed.");
    process.exitCode = 1;
    return;
  }

  console.log(`Bridge revoked: ${result.rows[0]!.id}`);
  console.log("Repeated revocation is safe.");
}

try {
  await revokeBridge();
} catch {
  console.error(
    "Bridge revocation failed. Check the UUID argument, development environment, and admin database access.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}