import { timingSafeEqual } from "node:crypto";

const TOKEN_PATTERN = /^mesh_receiver_[0-9a-f]{64}$/;

export function createReceiverAuthenticator(
    expectedToken: string,
): (authorization: unknown) => boolean {
    if (expectedToken.length !== 78 || !TOKEN_PATTERN.test(expectedToken)) {
        throw new Error("Invalid receiver token configuration.");
    }

    const expected = Buffer.from(expectedToken, "ascii");

    return (authorization: unknown): boolean => {
        if (typeof authorization !== "string") {
            return false;
        }

        const match = /^Bearer (mesh_receiver_[0-9a-f]{64})$/i.exec(
            authorization,
        );

        if (!match || match[0] !== authorization) {
            return false;
        }

        const suppliedToken = match[1];

        // Token values are case-sensitive.
        if (!suppliedToken || !TOKEN_PATTERN.test(suppliedToken)) {
            return false;
        }

        const supplied = Buffer.from(suppliedToken, "ascii");

        return (
            supplied.length === expected.length &&
            timingSafeEqual(supplied, expected)
        );
    };
}