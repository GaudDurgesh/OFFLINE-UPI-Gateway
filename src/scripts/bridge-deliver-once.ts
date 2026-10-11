import {readApiKey} from "../bridge/credentials.js"
import { BridgeOutbox } from "../bridge/outbox.js";
import { createGatewayClient } from "../bridge/gateway-client.js";
import { createDeliveryWorker } from "../bridge/delivery-worker.js";
import { acquireDeliveryLock } from "../bridge/delivery-lock.js";

async function deliverOnce() {
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

  const apiKey = await readApiKey(args[1]);

  const deliver = createGatewayClient({
    gatewayOrigin: args[0],
    apiKey,
  });

  const releaseLock = acquireDeliveryLock(directory);

  try {
    const outbox = new BridgeOutbox(directory);

    try {
      const worker = createDeliveryWorker(outbox, deliver);
      const result = await worker.runOnce();

      console.log(JSON.stringify(result, null, 2));

      if (result.status === "RETRY") {
        process.exitCode = 2;
      } else if (result.status === "PAUSED") {
        process.exitCode = 3;
      }
    } finally {
      outbox.close();
    }
  } finally {
    releaseLock();
  }
}

try {
  await deliverOnce();
} catch {
  console.error(
    "Delivery command failed. Usage: npm run bridge:deliver-once -- " +
    "<gateway-origin> <credential-file>. Check arguments, credentials, " +
    "and queue access. Any uncertain delivery must be retried using " +
    "the existing packet.",
  );
  process.exitCode = 1;
}