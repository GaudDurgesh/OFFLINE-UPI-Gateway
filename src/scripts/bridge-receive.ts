import { createServer } from "node:http";
import { isIPv4 } from "node:net";

const host = process.env.BRIDGE_LISTEN_HOST;
const port = 8787;

if (!host || !isIPv4(host)) {
  throw new Error("Set BRIDGE_LISTEN_HOST to the laptop's local IPv4 address.");
}

const server = createServer(
  {
    headersTimeout: 10_000,
    requestTimeout: 15_000,
    keepAliveTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
    maxHeaderSize: 8 * 1024,
  },
  (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: "ok",
        service: "offline-upi-local-bridge",
      }));
      return;
    }

    req.resume();
    res.writeHead(404);
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  },
);

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`Local receiver failed: ${error.code ?? "UNKNOWN"}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Local receiver: http://${host}:${port}/health`);
});

let stopping = false;

function shutdown() {
  if (stopping) return;
  stopping = true;

  const deadline = setTimeout(() => {
    console.error("Receiver shutdown deadline exceeded.");
    process.exit(1);
  }, 20_000);

  server.close((error) => {
    clearTimeout(deadline);
    if (error) process.exitCode = 1;
    console.log("Local receiver stopped.");
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);