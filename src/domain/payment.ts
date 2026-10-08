import { z } from "zod";

const MAX_BIGINT = 9223372036854775807n;

const uuid = z.string().uuid().transform((value) => value.toLowerCase());

const positiveIntegerString = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, "Expected a positive integer string")
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value) <= MAX_BIGINT,
    "Value exceeds the supported integer range",
  );

export const paymentSchema = z
  .object({
    version: z.literal(1),
    paymentId: uuid,
    deviceId: uuid,
    senderAccountId: uuid,
    receiverAccountId: uuid,
    amountPaise: positiveIntegerString,
    counter: positiveIntegerString,
    signedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (payment) => payment.senderAccountId !== payment.receiverAccountId,
    {
      message: "Sender and receiver must be different",
      path: ["receiverAccountId"],
    },
  );

export type PaymentPayload = z.infer<typeof paymentSchema>;

export function encodePayment(input: unknown): Buffer {
  const payment = paymentSchema.parse(input);

  // Explicit field order gives both sides identical signing bytes.
  const ordered = {
    version: payment.version,
    paymentId: payment.paymentId,
    deviceId: payment.deviceId,
    senderAccountId: payment.senderAccountId,
    receiverAccountId: payment.receiverAccountId,
    amountPaise: payment.amountPaise,
    counter: payment.counter,
    signedAt: payment.signedAt,
  };

  return Buffer.from(
    `offline-upi-gateway:payment:v1\n${JSON.stringify(ordered)}`,
    "utf8",
  );
}