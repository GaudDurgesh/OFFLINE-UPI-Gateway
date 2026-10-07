import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
    query_timeout: 10000,
});

pool.on("error", () => {
    console.error("An idle database connection failed.");
});