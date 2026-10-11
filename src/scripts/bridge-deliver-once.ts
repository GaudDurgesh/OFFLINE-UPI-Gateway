import { open } from "node:fs/promises";
import { isBridgeKey } from "../crypto/bridge-keys.js";
import { BridgeOutbox } from "../bridge/outbox.js";
import { createGatewayClient } from "../bridge/gateway-client.js";
import { createDeliveryWorker } from "../bridge/delivery-worker.js";

async function readApiKey(filename: string): Promise<string> {
  const file = await open(filename, "r");

  try {
    const info = await file.stat();
    const limit = 4 * 1024;

    if (!info.isFile() || info.size === 0 || info.size > limit) {
      throw new Error("Invalid credential file.");
    }

    const buffer = Buffer.alloc(limit + 1);
    let total = 0;

    while (total < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        total,
        buffer.length - total,
        null,
      );

      if (bytesRead === 0) {
        break;
      }

      total += bytesRead;
    }

    if (total === 0 || total > limit) {
      throw new Error("Invalid credential file size.");
    }

    const text = new TextDecoder("utf-8", {
      fatal: true,
    }).decode(buffer.subarray(0, total));

    const credentials: unknown = JSON.parse(text);

    if (
      typeof credentials !== "object" ||
      credentials === null ||
      !("apiKey" in credentials) ||
      !isBridgeKey(credentials.apiKey)
    ) {
      throw new Error("Invalid bridge credential.");
    }

    return credentials.apiKey;
  } finally {
    await file.close();
  }
}

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

  const outbox = new BridgeOutbox(directory);

  try {
    const worker = createDeliveryWorker(outbox, deliver);
    const result = await worker.runOnce();

    console.log(JSON.stringify(result, null, 2));

    // Distinguish pending retries and pauses for command-line callers.
    if (result.status === "RETRY") {
      process.exitCode = 2;
    } else if (result.status === "PAUSED") {
      process.exitCode = 3;
    }
  } finally {
    outbox.close();
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