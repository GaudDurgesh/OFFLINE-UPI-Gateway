import { setTimeout as sleep } from "node:timers/promises";
import { readApiKey } from "../bridge/credentials.js";
import { acquireDeliveryLock } from "../bridge/delivery-lock.js";
import { createDeliveryWorker } from "../bridge/delivery-worker.js";
import { createGatewayClient } from "../bridge/gateway-client.js";
import { BridgeOutbox } from "../bridge/outbox.js";

const POLL_INTERVAL_MS = 1_200;
const SHUTDOWN_TIMEOUT_MS = 30_000;

async function runBridge() {
  const args = process.argv.slice(2);

  if (
    args.length !== 2 ||
    !args[0]?.trim() ||
    !args[1]?.trim()
  ) {
    throw new Error("Gateway origin and credential file are required.");
  }

  const directory = process.env.BRIDGE_DATA_DIR ?? ".bridge-data";

  if (!directory.trim()) {
    throw new Error("Bridge data directory cannot be empty.");
  }

  const apiKey = await readApiKey(args[1], args[0]);

  const deliver = createGatewayClient({
    gatewayOrigin: args[0],
    apiKey,
  });

  const releaseLock = acquireDeliveryLock(directory);

  try {
    const outbox = new BridgeOutbox(directory);

    try {
      const worker = createDeliveryWorker(outbox, deliver);
      const stopping = new AbortController();

      let deadline: ReturnType<typeof setTimeout> | undefined;

      function stop(): void {
        if (stopping.signal.aborted) {
          return;
        }

        stopping.abort();

        console.log(JSON.stringify({
          event: "bridge_stopping",
        }));

        deadline = setTimeout(() => {
          console.error("Bridge shutdown deadline exceeded.");
          process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
      }

      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      try {
        console.log(JSON.stringify({
          event: "bridge_started",
        }));

        while (!stopping.signal.aborted) {
          const result = await worker.runOnce();

          if (result.status === "BUSY") {
            throw new Error("Unexpected overlapping worker execution.");
          }

          if (result.status !== "IDLE") {
            console.log(JSON.stringify({
              event: "bridge_delivery",
              result,
            }));
          }

          if (result.status === "PAUSED") {
            process.exitCode = 3;
            break;
          }

          if (stopping.signal.aborted) {
            break;
          }

          try {
            await sleep(POLL_INTERVAL_MS, undefined, {
              signal: stopping.signal,
            });
          } catch (error) {
            if (!stopping.signal.aborted) {
              throw error;
            }
          }
        }
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);

        if (deadline !== undefined) {
          clearTimeout(deadline);
        }
      }
    } finally {
      outbox.close();
    }
  } finally {
    releaseLock();
  }

  console.log(JSON.stringify({
    event: "bridge_stopped",
  }));
}

try {
  await runBridge();
} catch {
  console.error(
    "Bridge runner failed. Usage: npm run bridge:run -- " +
    "<gateway-origin> <credential-file>. Check configuration, " +
    "queue access, and whether another delivery process is running.",
  );
  process.exitCode = 1;
}