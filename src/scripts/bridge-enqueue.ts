import { open } from "node:fs/promises";
import { BridgeOutbox } from "../bridge/outbox.js";
import { validatePacket } from "../domain/packet.js";

const MAX_FILE_BYTES = 16 * 1024;

async function enqueuePacket() {
  const args = process.argv.slice(2);

  if (args.length !== 1 || !args[0]?.trim()) {
    throw new Error("A packet file path is required.");
  }

  const file = await open(args[0], "r");
  let input: unknown;

  try {
    const info = await file.stat();

    if (
      !info.isFile() ||
      info.size === 0 ||
      info.size > MAX_FILE_BYTES
    ) {
      throw new Error("Invalid packet file size or type.");
    }

    // Read at most the limit plus one byte, even if the file grows.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
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

    if (total === 0 || total > MAX_FILE_BYTES) {
      throw new Error("Packet file exceeds the size limit.");
    }

    const text = new TextDecoder("utf-8", {
      fatal: true,
    }).decode(buffer.subarray(0, total));

    input = JSON.parse(text);
  } finally {
    await file.close();
  }

  const validated = validatePacket(input);

  if (!validated.ok) {
    throw new Error("Invalid packet structure.");
  }

  // Open the queue only after validating the file.
  const directory = process.env.BRIDGE_DATA_DIR ?? ".bridge-data";

  if (!directory.trim()) {
    throw new Error("Bridge data directory cannot be empty.");
  }

  const outbox = new BridgeOutbox(directory);

  try {
    const result = outbox.enqueue(validated.packet);

    console.log(JSON.stringify({
      event: result.inserted
        ? "packet_queued"
        : "packet_already_known",
      packetHash: result.packetHash,
    }));
  } finally {
    outbox.close();
  }
}

try {
  await enqueuePacket();
} catch {
  // Avoid printing packet contents or filesystem error details.
  console.error(
    "Enqueue failed. Usage: npm run bridge:enqueue -- <packet.json>. " +
    "The file must contain a valid packet and be at most 16 KiB; " +
    "the queue directory must be writable.",
  );
  process.exitCode = 1;
}