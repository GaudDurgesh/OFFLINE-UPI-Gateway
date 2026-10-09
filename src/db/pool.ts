import pg from "pg";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { config } from "../config.js";

const { Pool } = pg;
setDefaultAutoSelectFamilyAttemptTimeout(
    config.NETWORK_ATTEMPT_TIMEOUT_MS,
);

export const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,

    // PostgreSQL cancels statements running longer than 8 seconds.
    statement_timeout: 8_000,

    // PostgreSQL cancels statements waiting on a lock for 3 seconds.
    lock_timeout: 3_000,

    // Close sessions left idle inside a transaction for 10 seconds.
    idle_in_transaction_session_timeout: 10_000,

    // Client fallback: longer than the server statement timeout.
    query_timeout: 12_000,

    application_name: "offline-upi-gateway",
});

pool.on("error", () => {
    console.error("An idle database connection failed.");
});