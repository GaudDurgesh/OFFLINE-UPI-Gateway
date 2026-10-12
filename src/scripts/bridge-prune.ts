import { BridgeOutbox } from "../bridge/outbox.js";

function pruneCompletedPackets() {
  if (process.argv.slice(2).length !== 0) {
    throw new Error("This command does not accept arguments.");
  }

  const directory = process.env.BRIDGE_DATA_DIR ?? ".bridge-data";

  if (!directory.trim()) {
    throw new Error("Bridge data directory cannot be empty.");
  }

  const outbox = new BridgeOutbox(directory);

  try {
    const removed = outbox.pruneCompleted();

    console.log(JSON.stringify({
      event: "outbox_pruned",
      removed,
    }));
  } finally {
    outbox.close();
  }
}

try {
  pruneCompletedPackets();
} catch {
  console.error(
    "Outbox cleanup failed. Check the queue directory and command arguments.",
  );
  process.exitCode = 1;
}