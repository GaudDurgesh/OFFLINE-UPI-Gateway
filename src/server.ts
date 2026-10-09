import app from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { createServer } from "node:http";

const SHUTDOWN_TIMEOUT_MS = 30_000;

const server = createServer(
  {
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
    maxHeaderSize: 16 * 1024,
  },
  app,
);

server.listen(config.PORT, () => {
  console.log(`Server running at http://localhost:${config.PORT}`);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`${signal} received. Stopping new connections.`);

  // Keep this timer active until HTTP and database cleanup finish.
  const deadline = setTimeout(() => {
    console.error("Shutdown deadline exceeded. Forcing exit.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // Stop accepting connections and let active requests finish.
  server.close((error) => {
    void (async () => {
      let exitCode = error || process.exitCode ? 1 : 0;

      if (error) {
        console.error("HTTP server shutdown failed.");
      }

      try {
        await pool.end();
        console.log("Database pool closed.");
      } catch {
        exitCode = 1;
        console.error("Database pool shutdown failed.");
      }

      clearTimeout(deadline);
      process.exitCode = exitCode;
      console.log("Shutdown complete.");
    })();
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    `HTTP server error: ${error.code ?? "UNKNOWN"}`,
  );
  process.exitCode = 1;
  shutdown("SERVER_ERROR");
});