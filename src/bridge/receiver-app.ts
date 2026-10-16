import express from "express";
import type { ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { validatePacket } from "../domain/packet.js";
import { createReceiverAuthenticator } from "./receiver-auth.js";
import { OutboxCapacityError, type BridgeOutbox } from "./outbox.js";
import { receiverPage, receiverScript } from "./receiver-page.js";

export function createReceiverApp(
    outbox: Pick<BridgeOutbox, "enqueue" | "getPacketStatus">,
    token: string,
) {
    const authenticate = createReceiverAuthenticator(token);
    const app = express();

    app.disable("x-powered-by");

    app.use((_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        next();
    });

    app.get("/", (_req, res) => {
        res.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
            "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; " +
            "form-action 'none'",
        );
        res.setHeader("Referrer-Policy", "no-referrer");
        res.type("html").send(receiverPage);
    });

    app.get("/receiver.js", (_req, res) => {
        res.type("application/javascript").send(receiverScript);
    });

    app.get("/health", (_req, res) => {
        res.status(200).json({
            status: "ok",
            service: "offline-upi-local-bridge",
        });
    });

    // Applies to packet submission and packet-result lookup.
    // Browser requests must originate from this receiver's own page.
    // CLI clients may omit Fetch Metadata headers; authentication still applies.
    app.use("/packets", (req, res, next) => {
        res.vary("Sec-Fetch-Site");

        const site = req.get("sec-fetch-site");

        if (site !== undefined && site !== "same-origin") {
            res.status(403).json({
                error: "CROSS_ORIGIN_REQUEST_BLOCKED",
            });
            return;
        }

        next();
    });

    app.post(
        "/packets",
        rateLimit({
            windowMs: 60_000,
            limit: 60,
            standardHeaders: "draft-8",
            legacyHeaders: false,
            message: { error: "RATE_LIMITED" },
        }),
        (req, res, next) => {
            if (!authenticate(req.get("authorization"))) {
                res.setHeader("WWW-Authenticate", "Bearer");
                res.status(401).json({ error: "UNAUTHORIZED" });
                return;
            }

            next();
        },
        (req, res, next) => {
            if (!req.is("application/json")) {
                res.status(415).json({ error: "UNSUPPORTED_MEDIA_TYPE" });
                return;
            }

            next();
        },
        express.json({
            limit: "16kb",
            strict: true,
            inflate: false,
        }),
        (req, res, next) => {
            const checked = validatePacket(req.body);

            if (!checked.ok) {
                res.status(400).json({ error: "INVALID_PACKET" });
                return;
            }

            try {
                const result = outbox.enqueue(checked.packet);

                res.status(result.inserted ? 202 : 200).json({
                    status: result.inserted ? "QUEUED" : "ALREADY_KNOWN",
                    packetHash: result.packetHash,
                });
            } catch (error) {
                if (error instanceof OutboxCapacityError) {
                    res.setHeader("Retry-After", "60");
                    res.status(503).json({ error: "OUTBOX_FULL" });
                    return;
                }

                next(error);
            }
        },
    );

    app.get(
        "/packets/:packetHash",
        rateLimit({
            windowMs: 60_000,
            limit: 60,
            standardHeaders: "draft-8",
            legacyHeaders: false,
            message: { error: "RATE_LIMITED" },
        }),
        (req, res, next) => {
            if (!authenticate(req.get("authorization"))) {
                res.setHeader("WWW-Authenticate", "Bearer");
                res.status(401).json({ error: "UNAUTHORIZED" });
                return;
            }

            next();
        },
        (req, res, next) => {
            const packetHash = req.params.packetHash;

            if (
                typeof packetHash !== "string" ||
                packetHash.length !== 64 ||
                !/^[0-9a-f]{64}$/.test(packetHash)
            ) {
                res.status(400).json({ error: "INVALID_PACKET_HASH" });
                return;
            }

            try {
                const result = outbox.getPacketStatus(packetHash);

                res
                    .status(result.deliveryStatus === "NOT_FOUND" ? 404 : 200)
                    .json(result);
            } catch (error) {
                next(error);
            }
        },
    );

    app.use((_req, res) => {
        res.status(404).json({ error: "NOT_FOUND" });
    });

    const handleError: ErrorRequestHandler = (
        error: unknown,
        _req,
        res,
        next,
    ) => {
        if (res.headersSent) {
            next(error);
            return;
        }

        const type =
            typeof error === "object" &&
                error !== null &&
                "type" in error
                ? error.type
                : undefined;

        if (type === "entity.too.large") {
            res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
            return;
        }

        if (
            type === "entity.parse.failed" ||
            type === "request.aborted" ||
            type === "request.size.invalid"
        ) {
            res.status(400).json({ error: "INVALID_REQUEST" });
            return;
        }

        if (
            type === "encoding.unsupported" ||
            type === "charset.unsupported"
        ) {
            res.status(415).json({ error: "UNSUPPORTED_ENCODING" });
            return;
        }

        console.error(JSON.stringify({
            event: "receiver_request_failed",
        }));

        res.status(500).json({ error: "INTERNAL_ERROR" });
    };

    app.use(handleError);

    return app;
}