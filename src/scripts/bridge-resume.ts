import { BridgeOutbox } from "../bridge/outbox.js";

function resumeBridge() {
  if (process.argv.slice(2).length !== 0) {
    throw new Error("This command does not accept arguments.");
  }

  const directory = process.env.BRIDGE_DATA_DIR ?? ".bridge-data";

  if (!directory.trim()) {
    throw new Error("Bridge data directory cannot be empty.");
  }

  const outbox = new BridgeOutbox(directory);

  try {
    const pause = outbox.getDeliveryPause();

    if (!pause) {
      console.log(JSON.stringify({
        event: "bridge_not_paused",
      }));
      return;
    }

    outbox.resumeDelivery();

    console.log(JSON.stringify({
      event: "bridge_resumed",
    }));
  } finally {
    outbox.close();
  }
}

try {
  resumeBridge();
} catch {
  console.error(
    "Could not resume bridge delivery. Check the queue directory and command arguments.",
  );
  process.exitCode = 1;
}