import { BridgeOutbox } from "../bridge/outbox.js";

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
    console.log(JSON.stringify(outbox.getSummary(), null, 2));
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