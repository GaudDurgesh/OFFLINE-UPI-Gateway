import type { PoolClient } from "pg";
import { pool } from "./pool.js";

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;

  try {
    await client.query("BEGIN");
    await client.query(`
  SET LOCAL statement_timeout = '8s';
  SET LOCAL lock_timeout = '3s';
  SET LOCAL idle_in_transaction_session_timeout = '10s';
`);

    const result = await work(client);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    discardClient = true;

    try {
      await client.query("ROLLBACK");
    } catch {
      console.error("Could not confirm transaction rollback.");
    }

    throw error;
  } finally {
    client.release(discardClient);
  }
}