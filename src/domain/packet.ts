import { createHash } from "node:crypto";
import { z } from "zod";

// Must match the layout and limits in crypto/hybrid.ts.
const OVERHEAD = 256 + 12 + 16;
const MAX_PACKET_BYTES = OVERHEAD + 4096;
const MAX_BASE64_LENGTH = Math.ceil(MAX_PACKET_BYTES / 3) * 4;

const ciphertextSchema = z
  .string()
  .max(MAX_BASE64_LENGTH)
  .refine((value) => {
    // Check before allocating a decoded buffer.
    if (value.length === 0 || value.length > MAX_BASE64_LENGTH) {
      return false;
    }

    const decoded = Buffer.from(value, "base64");

    return (
      decoded.length > OVERHEAD &&
      decoded.length <= MAX_PACKET_BYTES &&
      decoded.toString("base64") === value
    );
  }, "Invalid ciphertext encoding or size");

export const packetSchema = z
  .object({
    packetId: z.string().uuid(),
    ttl: z.number().int().min(0).max(5),
    createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    ciphertext: ciphertextSchema,
  })
  .strict();

export type MeshPacket = z.infer<typeof packetSchema>;

type PacketValidationResult =
  | {
      ok: true;
      packet: MeshPacket;
      packetHash: string;
    }
  | {
      ok: false;
      reason: "INVALID_PACKET";
    };

export function validatePacket(input: unknown): PacketValidationResult {
  const parsed = packetSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, reason: "INVALID_PACKET" };
  }

  const bytes = Buffer.from(parsed.data.ciphertext, "base64");
  const packetHash = createHash("sha256").update(bytes).digest("hex");

  return {
    ok: true,
    packet: parsed.data,
    packetHash,
  };
}