import { open } from "node:fs/promises";
import { isBridgeKey } from "../crypto/bridge-keys.js";
import { validateGatewayOrigin } from "./gateway-origin.js";

export async function readApiKey(
    filename: string,
    requestedOrigin: string,
): Promise<string> {
    const destination = validateGatewayOrigin(requestedOrigin);
    const file = await open(filename, "r");

    try {
        const info = await file.stat();
        const limit = 4 * 1024;

        if (!info.isFile() || info.size === 0 || info.size > limit) {
            throw new Error("Invalid credential file.");
        }

        const buffer = Buffer.alloc(limit + 1);
        let total = 0;

        while (total < buffer.length) {
            const { bytesRead } = await file.read(
                buffer,
                total,
                buffer.length - total,
                null,
            );

            if (bytesRead === 0) {
                break;
            }

            total += bytesRead;
        }

        if (total === 0 || total > limit) {
            throw new Error("Invalid credential file size.");
        }

        const text = new TextDecoder("utf-8", {
            fatal: true,
        }).decode(buffer.subarray(0, total));

        const credentials: unknown = JSON.parse(text);

        if (
            typeof credentials !== "object" ||
            credentials === null ||
            !("apiKey" in credentials) ||
            !isBridgeKey(credentials.apiKey)
        ) {
            throw new Error("Invalid bridge credential.");
        }

        if (!("gatewayOrigin" in credentials)) {
            throw new Error("Bridge credential has no approved gateway origin.");
        }

        const approvedOrigin = validateGatewayOrigin(
            credentials.gatewayOrigin,
        );

        if (approvedOrigin !== destination) {
            throw new Error("Bridge credential is not approved for this gateway.");
        }

        return credentials.apiKey;
    } finally {
        await file.close();
    }
}
