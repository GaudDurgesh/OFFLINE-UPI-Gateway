import { z } from "zod";

const transactionIdSchema = z.string().refine(
    (value) =>
        /^[1-9][0-9]{0,18}$/.test(value) &&
        BigInt(value) <= 9223372036854775807n,
    "Invalid transaction ID",
);

const reasonSchema = z.string().min(1).max(128);

const outcomeSchema = z.discriminatedUnion("status", [
    z.object({
        status: z.literal("SETTLED"),
        transactionId: transactionIdSchema,
    }).strict(),

    z.object({
        status: z.literal("DUPLICATE"),
        transactionId: transactionIdSchema,
    }).strict(),

    z.object({
        status: z.literal("INVALID"),
        reason: reasonSchema,
    }).strict(),

    z.object({
        status: z.literal("REJECTED"),
        reason: reasonSchema,
    }).strict(),
]);

const gatewayResponseSchema = z.object({
    packetHash: z.string().regex(/^[0-9a-f]{64}$/),
    repeated: z.boolean(),
    outcome: outcomeSchema,
}).strict();

export type GatewayResponse = z.infer<
    typeof gatewayResponseSchema
>;

export function validateGatewayResponse(
    input: unknown,
    expectedPacketHash: string,
):
    | { ok: true; response: GatewayResponse }
    | { ok: false; reason: "INVALID_GATEWAY_RESPONSE" } {
    const parsed = gatewayResponseSchema.safeParse(input);

    if (
        !parsed.success ||
        parsed.data.packetHash !== expectedPacketHash
    ) {
        return {
            ok: false,
            reason: "INVALID_GATEWAY_RESPONSE",
        };
    }

    return {
        ok: true,
        response: parsed.data,
    };
}