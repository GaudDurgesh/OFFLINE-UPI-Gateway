import {
  BridgeOutbox,
  MAX_STORED_PACKETS,
} from "../bridge/outbox.js";

function showStatus() {
  if (process.argv.slice(2).length !== 0) {
    throw new Error("This command does not accept arguments.");
  }

  const directory = process.env.BRIDGE_DATA_DIR ?? ".bridge-data";

  if (!directory.trim()) {
    throw new Error("Bridge data directory cannot be empty.");
  }

  const outbox = new BridgeOutbox(directory);

  try {
    const summary = outbox.getSummary();

    console.log(JSON.stringify({
      ...summary,
      capacity: MAX_STORED_PACKETS,
      remainingSlots: Math.max(0, MAX_STORED_PACKETS - summary.total),
      full: summary.total >= MAX_STORED_PACKETS,
    }, null, 2));
  } finally {
    outbox.close();
  }
}

try {
  showStatus();
} catch {
  console.error(
    "Could not read bridge status. Check the queue directory and command arguments.",
  );
  process.exitCode = 1;
}