import { BridgeOutbox } from "../bridge/outbox.js";

function showResult() {
  const args = process.argv.slice(2);
  const packetHash = args[0];

  if (
    args.length !== 1 ||
    typeof packetHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(packetHash)
  ) {
    throw new Error("Exactly one lowercase SHA-256 packet hash is required.");
  }

  const directory = process.env.BRIDGE_DATA_DIR ?? ".bridge-data";

  if (!directory.trim()) {
    throw new Error("Bridge data directory cannot be empty.");
  }

  const outbox = new BridgeOutbox(directory);

  try {
    const result = outbox.getPacketStatus(packetHash);
    console.log(JSON.stringify(result, null, 2));

    if (result.deliveryStatus === "NOT_FOUND") {
      process.exitCode = 2;
    }
  } finally {
    outbox.close();
  }
}

try {
  showResult();
} catch {
  console.error(
    "Result lookup failed. Supply exactly one 64-character lowercase " +
    "packet hash and check queue access.",
  );
  process.exitCode = 1;
}