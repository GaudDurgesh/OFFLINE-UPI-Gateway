import { createServer } from "node:https";
import { open, readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { BridgeOutbox } from "../bridge/outbox.js";
import { createReceiverApp } from "../bridge/receiver-app.js";
import express from "express";
import { createReceiverBoundary } from "../bridge/receiver-boundary.js";

async function readReceiverToken(): Promise<string> {
  const file = await open(".keys/receiver.json", "r");

  try {
    const info = await file.stat();
    const limit = 4096;

    if (!info.isFile() || info.size === 0 || info.size > limit) {
      throw new Error("Invalid receiver credential file.");
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

      if (bytesRead === 0) break;
      total += bytesRead;
    }

    if (total === 0 || total > limit) {
      throw new Error("Invalid receiver credential size.");
    }

    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(buffer.subarray(0, total));

    const value: unknown = JSON.parse(text);

    if (
      typeof value !== "object" ||
      value === null ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      value.token.length !== 78 ||
      !/^mesh_receiver_[0-9a-f]{64}$/.test(value.token)
    ) {
      throw new Error("Invalid receiver credential.");
    }

    return value.token;
  } finally {
    await file.close();
  }
}

async function main(): Promise<void> {
  const host = process.env.BRIDGE_LISTEN_HOST;
  const directory = process.env.BRIDGE_DATA_DIR ?? ".bridge-data";
  const port = 8787;

  if (
    !host ||
    !isIPv4(host) ||
    host === "0.0.0.0" ||
    !directory.trim()
  ) {
    throw new Error("Invalid receiver configuration.");
  }

  // Validate credentials and read TLS files before opening the queue.
  const token = await readReceiverToken();
  const key = await readFile(".keys/receiver-key.pem");
  const cert = await readFile(".keys/receiver-cert.pem");

  const outbox = new BridgeOutbox(directory);

  try {
    const app = express();

    app.disable("x-powered-by");
    app.set("trust proxy", false);

    app.use(
      createReceiverBoundary(`https://${host}:${port}`),
    );

    app.use(createReceiverApp(outbox, token));

    const server = createServer(
      {
        key,
        cert,
        minVersion: "TLSv1.2",
        headersTimeout: 10_000,
        requestTimeout: 15_000,
        keepAliveTimeout: 5_000,
        connectionsCheckingInterval: 1_000,
        maxHeaderSize: 8 * 1024,
      },
      app,
    );

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);

      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    console.log(`Local receiver: https://${host}:${port}/health`);

    // Keep the queue open until active HTTP requests finish.
    await new Promise<void>((resolve, reject) => {
      let stopping = false;

      function shutdown(): void {
        if (stopping) return;
        stopping = true;

        console.log("Stopping local receiver.");

        const deadline = setTimeout(() => {
          console.error("Receiver shutdown deadline exceeded.");
          process.exit(1);
        }, 20_000);

        server.close((error) => {
          clearTimeout(deadline);
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
          server.off("error", onServerError);

          if (error) reject(error);
          else resolve();
        });
      }

      function onServerError(): void {
        console.error("Local receiver server error.");
        process.exitCode = 1;
        shutdown();
      }

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      server.on("error", onServerError);
    });
  } finally {
    outbox.close();
  }

  console.log("Local receiver stopped; queue closed.");
}

try {
  await main();
} catch {
  console.error(
    "Receiver failed. Check the listen address, receiver credentials, " +
    "TLS files, port availability, and queue directory access.",
  );
  process.exitCode = 1;
}