import type { PoolClient } from "pg";
import { encodePayment, paymentSchema } from "../domain/payment.js";
import type { PaymentPayload } from "../domain/payment.js";
import { verifyMessage } from "../crypto/signature.js";

type VerificationResult =
  | {
      status: "VERIFIED";
      payment: PaymentPayload;
    }
  | {
      status: "INVALID";
      reason:
        | "INVALID_PAYLOAD"
        | "INVALID_SIGNATURE"
        | "UNKNOWN_DEVICE"
        | "DEVICE_REVOKED"
        | "DEVICE_ACCOUNT_MISMATCH";
    };

type DeviceRow = {
  account_id: string;
  public_key_pem: string;
  status: "active" | "revoked";
};

// Call inside withTransaction using its client.
export async function verifyPayment(
  client: PoolClient,
  input: unknown,
  signature: unknown,
): Promise<VerificationResult> {
  const parsed = paymentSchema.safeParse(input);

  if (!parsed.success) {
    return { status: "INVALID", reason: "INVALID_PAYLOAD" };
  }

  if (typeof signature !== "string" || signature.length !== 88) {
    return { status: "INVALID", reason: "INVALID_SIGNATURE" };
  }

  const payment = parsed.data;

  const result = await client.query<DeviceRow>(
    `SELECT account_id, public_key_pem, status
     FROM devices
     WHERE id = $1
     FOR SHARE`,
    [payment.deviceId],
  );

  const device = result.rows[0];

  if (!device) {
    return { status: "INVALID", reason: "UNKNOWN_DEVICE" };
  }

  if (device.status !== "active") {
    return { status: "INVALID", reason: "DEVICE_REVOKED" };
  }

  if (device.account_id !== payment.senderAccountId) {
    return { status: "INVALID", reason: "DEVICE_ACCOUNT_MISMATCH" };
  }

  const validSignature = verifyMessage(
    encodePayment(payment),
    signature,
    device.public_key_pem,
  );

  if (!validSignature) {
    return { status: "INVALID", reason: "INVALID_SIGNATURE" };
  }

  return { status: "VERIFIED", payment };
}