import { config } from "../config.js";
import { pool } from "./pool.js";

async function seed() {
  if (config.NODE_ENV !== "development") {
    throw new Error("Demo seeding is allowed only in development.");
  }

  const result = await pool.query(`
    INSERT INTO accounts (vpa, name, balance_paise)
    VALUES
      ('alice@mesh', 'Alice', 100000),
      ('bob@mesh', 'Bob', 50000)
    ON CONFLICT (vpa) DO NOTHING
    RETURNING id
  `);

  console.log(`Created ${result.rows.length} demo account(s).`);

  const accounts = await pool.query(`
    SELECT id, vpa, name, balance_paise
    FROM accounts
    WHERE vpa IN ('alice@mesh', 'bob@mesh')
    ORDER BY vpa
  `);

  console.table(accounts.rows);
}

try {
  await seed();
} catch (error) {
  console.error(
    "Seed failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}