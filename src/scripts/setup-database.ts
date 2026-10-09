import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "../db/pool.js";

async function runMigrations(through?: string): Promise<void> {
  const args = [
    "--import",
    "tsx",
    resolve("src/db/migrate.ts"),
  ];

  if (through !== undefined) {
    args.push(`--through=${through}`);
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);

    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(`Migration process failed: ${signal ?? code}`),
        );
      }
    });
  });
}

async function setupDatabase() {
  console.log("Stage 1/3: apply migrations through 006.");
  await runMigrations("006");

  console.log("Stage 2/3: provision runtime role and grants.");
  const sql = await readFile(
    resolve("db-admin/setup-runtime-role.sql"),
    "utf8",
  );

  const client = await pool.connect();

  try {
    await client.query(sql);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is discarded below.
    }
    throw error;
  } finally {
    client.release(true);
  }

  console.log("Stage 3/3: apply remaining migrations.");
  await runMigrations();

  console.log("Database setup completed successfully.");
}

try {
  await setupDatabase();
} catch {
  console.error(
    "Database setup failed. Later stages were not continued.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}