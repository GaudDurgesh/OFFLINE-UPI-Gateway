import type { MeshPacket } from "../domain/packet.js";
import type { DeliveryAttempt } from "./gateway-client.js";
import type { BridgeOutbox } from "./outbox.js";

type Deliver = (packet: MeshPacket) => Promise<DeliveryAttempt>;

export type WorkerResult =
  | { status: "IDLE" }
  | { status: "BUSY" }
  | DeliveryAttempt;

export function createDeliveryWorker(
  outbox: BridgeOutbox,
  deliver: Deliver,
  options: {
    now?: () => number;
    random?: () => number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  let running = false;

  async function runOnce(): Promise<WorkerResult> {
    if (running) {
      return { status: "BUSY" };
    }

    running = true;

    try {
      const pause = outbox.getDeliveryPause();

      if (pause) {
        return {
          status: "PAUSED",
          reason: pause.reason,
          httpStatus: pause.httpStatus,
        };
      }

      const pending = outbox.listPending(1, now())[0];

      if (!pending) {
        return { status: "IDLE" };
      }

      const result = await deliver(pending.packet);

      switch (result.status) {
        case "COMPLETED":
          outbox.markCompleted(
            pending.packetHash,
            result.response,
          );
          break;

        case "RETRY":
          outbox.scheduleRetry(
            pending.packetHash,
            result.retryAfter,
            now(),
            random(),
          );
          break;

        case "PAUSED":
          outbox.pauseDelivery({
            reason: result.reason,
            httpStatus: result.httpStatus,
          });
          break;
      }

      // Report success only after the local state was saved.
      return result;
    } finally {
      running = false;
    }
  }

  return { runOnce };
}