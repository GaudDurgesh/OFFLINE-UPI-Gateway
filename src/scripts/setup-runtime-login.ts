import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

async function setupRuntimeLogin() {
  if (config.NODE_ENV !== "development") {
    throw new Error("Run this setup only in development.");
  }

  const result = await pool.query(
    `SELECT rolcanlogin, rolsuper, rolcreatedb,
            rolcreaterole, rolreplication, rolbypassrls
     FROM pg_roles
     WHERE rolname = 'gateway_runtime'`,
  );

  assert.equal(result.rows.length, 1, "Runtime role is missing.");

  const role = result.rows[0];

  for (const flag of [
    "rolcanlogin",
    "rolsuper",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
    "rolbypassrls",
  ]) {
    assert.equal(role[flag], false, `Unexpected role capability: ${flag}`);
  }

  const password = randomBytes(32).toString("hex");

  const runtimeUrl = new URL(config.DATABASE_URL);
  runtimeUrl.username = "gateway_runtime";
  runtimeUrl.password = password;
  runtimeUrl.searchParams.set("sslmode", "verify-full");

  const directory = resolve(process.cwd(), ".keys");
  const filename = resolve(directory, "runtime-database.json");

  await mkdir(directory, { recursive: true, mode: 0o700 });

  // Save first, refuse to overwrite an existing credential.
  await writeFile(
    filename,
    JSON.stringify({ databaseUrl: runtimeUrl.toString() }, null, 2),
    { flag: "wx", mode: 0o600 },
  );

  // PostgreSQL role DDL does not accept a password bind parameter.
  // This value is generated locally and contains only hexadecimal digits.
  assert.match(password, /^[0-9a-f]{64}$/);

  await pool.query(
    `ALTER ROLE gateway_runtime LOGIN PASSWORD '${password}'`,
  );

  const runtime = new pg.Client({
    connectionString: runtimeUrl.toString(),
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    query_timeout: 12_000,
  });

  try {
    await runtime.connect();

    const identity = await runtime.query(
      "SELECT current_user AS role_name",
    );
    assert.equal(identity.rows[0].role_name, "gateway_runtime");

    // Check access without printing account data.
    await runtime.query("SELECT id FROM public.accounts LIMIT 0");

    console.log("PASS: runtime role can authenticate.");
    console.log("PASS: runtime role can query accounts.");
    console.log("Credential saved: .keys/runtime-database.json");
    console.log("Existing application connection unchanged.");
  } finally {
    await runtime.end();
  }
}

try {
  await setupRuntimeLogin();
} catch {
  // Never print a raw error from credential setup.
  console.error(
    "Runtime login setup failed. Keep any generated credential file; do not delete or overwrite it.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}