import arcjet, {
    createRemoteClient,
    shield,
    type ArcjetNodeRequest,
} from "@arcjet/node";
import type { Request } from "express";
import { isIP } from "node:net";
import { createConcurrencyGate } from "./concurrency-gate.js";
import type {
    ProtectionMode,
    ProtectionResult,
} from "../middleware/gateway-protection.js";

type ProtectionDecision = {
    isDenied(): boolean;
    isErrored(): boolean;
    isAllowed(): boolean;
    results: ReadonlyArray<{
        isDenied(): boolean;
        reason: {
            isError(): boolean;
        };
    }>;
};



export type ArcjetProtect = (
    request: ArcjetNodeRequest,
    options: { ipSrc: string },
) => Promise<ProtectionDecision>;

export function createArcjetCheck(
    mode: ProtectionMode,
    key?: string,
    protectOverride?: ArcjetProtect,
): (request: Request) => Promise<ProtectionResult> {

    const protect: ArcjetProtect = protectOverride ??
        ((request, options) => client!.protect(request, options));

    if (mode === "OFF") {
        return async () => "ALLOW";
    }

    if (!key) {
        throw new Error("Arcjet key is required.");
    }

    const client = protectOverride ? undefined : arcjet({
        key,
        rules: [shield({ mode })],
        client: createRemoteClient({ timeout: 1_000 }),

        // Our middleware logs only safe, structured outcomes.
        log: {
            debug() { },
            info() { },
            warn() { },
            error() { },
        },
    });

    const gate = createConcurrencyGate(4);

    return async (req): Promise<ProtectionResult> => {
        const ip = req.socket.remoteAddress;

        if (!ip || isIP(ip) === 0) {
            return "ERROR";
        }

        const headers: Record<string, string> = {};

        for (const name of ["user-agent", "content-type", "accept"]) {
            const value = req.get(name);

            if (value !== undefined && value.length <= 512) {
                headers[name] = value;
            }
        }

        // Fixed host, no query parameters, cookies, authorization,
        // request body, or access to the original request stream.
        headers.host = "gateway.invalid";

        const request: ArcjetNodeRequest = {
            method: req.method,
            httpVersion: req.httpVersion,
            url: req.originalUrl.split("?")[0] || "/",
            headers,
            socket: {
                remoteAddress: ip,
                encrypted: req.secure,
            },
        };

        const attempt = await gate.run(async (): Promise<ProtectionResult> => {
            const decision = await protect(request, {
                ipSrc: ip,
            });

            // DRY_RUN may have ALLOW at the top level but DENY
            // inside individual rule results.
            if (
                decision.isDenied() ||
                decision.results.some((result) => result.isDenied())
            ) {
                return "DENY";
            }

            if (
                decision.isErrored() ||
                decision.results.some((result) => result.reason.isError())
            ) {
                return "ERROR";
            }

            return decision.isAllowed() ? "ALLOW" : "ERROR";
        });

        return attempt.accepted ? attempt.value : "ERROR";
    };
}

