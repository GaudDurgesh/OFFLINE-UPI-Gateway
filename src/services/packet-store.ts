import type { PoolClient } from "pg";

export type PacketOutcome =
  | {
      status: "SETTLED" | "DUPLICATE";
      transactionId: string;
    }
  | {
      status: "INVALID" | "REJECTED";
      reason: string;
    };

type ClaimResult =
  | { claimed: true }
  | { claimed: false; outcome: PacketOutcome };

type PacketRow = {
  status: "PROCESSING" | PacketOutcome["status"];
  transaction_id: string | null;
  reason: string | null;
};

// Call inside the same transaction that will finalize this packet.
export async function claimPacket(
  client: PoolClient,
  packetHash: string,
): Promise<ClaimResult> {
  const inserted = await client.query(
    `INSERT INTO packets (packet_hash)
     VALUES ($1)
     ON CONFLICT (packet_hash) DO NOTHING
     RETURNING packet_hash`,
    [packetHash],
  );

  if (inserted.rows.length === 1) {
    return { claimed: true };
  }

  const existing = await client.query<PacketRow>(
    `SELECT status, transaction_id, reason
     FROM packets
     WHERE packet_hash = $1`,
    [packetHash],
  );

  const packet = existing.rows[0];

  if (!packet) {
    throw new Error("Packet disappeared after a claim conflict.");
  }

  if (packet.status === "PROCESSING") {
    throw new Error("Unexpected committed PROCESSING packet.");
  }

  if (
    packet.status === "SETTLED" ||
    packet.status === "DUPLICATE"
  ) {
    if (packet.transaction_id === null) {
      throw new Error("Completed packet is missing its transaction ID.");
    }

    return {
      claimed: false,
      outcome: {
        status: packet.status,
        transactionId: packet.transaction_id,
      },
    };
  }

  if (packet.reason === null) {
    throw new Error("Failed packet is missing its reason.");
  }

  return {
    claimed: false,
    outcome: {
      status: packet.status,
      reason: packet.reason,
    },
  };
}

export async function finishPacket(
  client: PoolClient,
  packetHash: string,
  outcome: PacketOutcome,
): Promise<void> {
  const transactionId =
    "transactionId" in outcome ? outcome.transactionId : null;

  const reason = "reason" in outcome ? outcome.reason : null;

  const updated = await client.query(
    `UPDATE packets
     SET status = $2,
         transaction_id = $3,
         reason = $4
     WHERE packet_hash = $1
       AND status = 'PROCESSING'
     RETURNING packet_hash`,
    [packetHash, outcome.status, transactionId, reason],
  );

  if (updated.rows.length !== 1) {
    throw new Error("Packet is missing or has already been finalized.");
  }
}