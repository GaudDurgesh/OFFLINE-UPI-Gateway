import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "./pool.js";

async function migrate() {
  const directory = resolve(process.cwd(), "migrations");
  const files = (await readdir(directory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();

  if (files.length === 0) {
    throw new Error("No migration files found.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Prevent two migration runners from changing the schema together.
    await client.query("SELECT pg_advisory_xact_lock(81001)");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const file of files) {
      const existing = await client.query(
        "SELECT filename FROM schema_migrations WHERE filename = $1",
        [file],
      );

      if (existing.rows.length > 0) {
        console.log(`Skipping: ${file}`);
        continue;
      }

      const sql = await readFile(resolve(directory, file), "utf8");

      console.log(`Applying: ${file}`);
      await client.query(sql);

      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
    }

    await client.query("COMMIT");
    console.log("Migrations completed successfully.");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      console.error("Could not confirm migration rollback.");
    }

    throw error;
  } finally {
    client.release(true);
  }
}

try {
  await migrate();
} catch (error) {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}