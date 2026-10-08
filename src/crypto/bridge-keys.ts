import { createHash, randomBytes } from "node:crypto";

export function generateBridgeKey(): string {
  return `mesh_bridge_${randomBytes(32).toString("hex")}`;
}

export function hashBridgeKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function isBridgeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^mesh_bridge_[0-9a-f]{64}$/.test(value)
  );
}