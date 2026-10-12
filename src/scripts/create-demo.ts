import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { generateDeviceKeyPair } from "../crypto/signature.js";
import { loadServerKeys } from "../crypto/server-keys.js";
import {
  generateBridgeKey,
  hashBridgeKey,
} from "../crypto/bridge-keys.js";
import { validatePacket } from "../domain/packet.js";
import { buildPacket } from "../services/build-packet.js";

async function createDemo() {
  if (config.NODE_ENV !== "development") {
    throw new Error("Demo creation is development-only.");
  }

  if (process.argv.slice(2).length !== 0) {
    throw new Error("This command does not accept arguments.");
  }

  const demoId = randomUUID();
  const senderId = randomUUID();
  const receiverId = randomUUID();
  const deviceId = randomUUID();
  const bridgeId = randomUUID();
  const paymentId = randomUUID();

  const deviceKeys = generateDeviceKeyPair();
  const serverKeys = await loadServerKeys();
  const apiKey = generateBridgeKey();

  const packet = buildPacket(
    {
      version: 1,
      paymentId,
      deviceId,
      senderAccountId: senderId,
      receiverAccountId: receiverId,
      amountPaise: "10000",
      counter: "1",
      signedAt: Date.now(),
    },
    deviceKeys.privateKey,
    serverKeys.publicKey,
  );

  const validated = validatePacket(packet);
  if (!validated.ok) {
    throw new Error("Generated demo packet failed validation.");
  }

  const dataDirectory = `.bridge-data/demo-${demoId}`;
  const keyDirectory = `.keys/demo-${demoId}`;
  const queueDirectory = `${dataDirectory}/queue`;
  const packetFile = `${dataDirectory}/packet.json`;
  const credentialFile = `${keyDirectory}/bridge.json`;
  const manifestFile = `${dataDirectory}/demo.json`;

  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });

  // Save files before activating the demo records in PostgreSQL.
  await writeFile(
    credentialFile,
    JSON.stringify({ bridgeId, name: "Demo Bridge", apiKey }, null, 2),
    { flag: "wx", mode: 0o600 },
  );

  await writeFile(
    packetFile,
    JSON.stringify(packet, null, 2),
    { flag: "wx", mode: 0o600 },
  );

  await writeFile(
    manifestFile,
    JSON.stringify({
      demoId,
      senderId,
      receiverId,
      deviceId,
      bridgeId,
      paymentId,
      packetHash: validated.packetHash,
      amountPaise: "10000",
      initialSenderBalancePaise: "50000",
      initialReceiverBalancePaise: "0",
      queueDirectory,
      packetFile,
      credentialFile,
    }, null, 2),
    { flag: "wx", mode: 0o600 },
  );

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO accounts (id, vpa, name, balance_paise)
       VALUES
         ($1, $2, 'Demo Sender', 50000),
         ($3, $4, 'Demo Receiver', 0)`,
      [
        senderId,
        `demo-${senderId}@mesh`,
        receiverId,
        `demo-${receiverId}@mesh`,
      ],
    );

    await client.query(
      `INSERT INTO devices (id, account_id, public_key_pem)
       VALUES ($1, $2, $3)`,
      [deviceId, senderId, deviceKeys.publicKey],
    );

    await client.query(
      `INSERT INTO bridge_nodes (id, name, api_key_hash)
       VALUES ($1, 'Demo Bridge', $2)`,
      [bridgeId, hashBridgeKey(apiKey)],
    );
  });

  console.log("Demo created. Payment has not been sent.");
  console.log("Starting balances: sender ₹500; receiver ₹0.");
  console.log("Payment amount: ₹100.");

  console.log(JSON.stringify({
    demoId,
    packetHash: validated.packetHash,
    manifestFile,
    packetFile,
    credentialFile,
    queueDirectory,
  }, null, 2));
}

try {
  await createDemo();
} catch {
  console.error(
    "Demo creation failed or its database commit could not be confirmed. " +
    "Keep any generated demo files for inspection. " +
    "Check the development environment, server keys, and admin database access.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}