import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { createReceiverApp } from "../bridge/receiver-app.js";

async function checkReceiverOrigin() {
    const token = `mesh_receiver_${randomBytes(32).toString("hex")}`;
    const packetHash = "a".repeat(64);
    let writes = 0;
    let reads = 0;

    const app = createReceiverApp(
        {
            enqueue() {
                writes += 1;
                return { inserted: true, packetHash };
            },
            getPacketStatus(hash) {
                reads += 1;
                return {
                    packetHash: hash,
                    deliveryStatus: "NOT_FOUND",
                    response: null,
                    retry: null,
                    pause: null,
                };
            },
        },
        token,
    );

    const server = app.listen(0, "127.0.0.1");

    try {
        await once(server, "listening");
        const address = server.address();
        assert(address && typeof address !== "string");

        const port = address.port;
        const packet = JSON.stringify({
            packetId: randomUUID(),
            ttl: 5,
            createdAt: Date.now(),
            ciphertext: randomBytes(300).toString("base64"),
        });

        // Use node:http so the test controls Fetch Metadata headers exactly.
        function send(
            method: "GET" | "POST" | "OPTIONS",
            site?: string,
            authenticated = true,
        ) {
            return new Promise<{
                status: number;
                body: string;
                allowOrigin: string | string[] | undefined;
            }>((resolve, reject) => {
                const headers: Record<string, string> = {};

                if (site !== undefined) {
                    headers["Sec-Fetch-Site"] = site;
                }

                if (authenticated) {
                    headers.Authorization = `Bearer ${token}`;
                }

                if (method === "POST") {
                    headers["Content-Type"] = "application/json";
                    headers["Content-Length"] = String(Buffer.byteLength(packet));
                }

                if (method === "OPTIONS") {
                    headers.Origin = "https://untrusted.example";
                    headers["Access-Control-Request-Method"] = "POST";
                    headers["Access-Control-Request-Headers"] = "authorization";
                }

                const req = request(
                    {
                        hostname: "127.0.0.1",
                        port,
                        path: method === "GET" ? `/packets/${packetHash}` : "/packets",
                        method,
                        headers,
                    },
                    (res) => {
                        let body = "";
                        res.setEncoding("utf8");
                        res.on("data", (chunk: string) => {
                            body += chunk;
                        });
                        res.on("error", reject);
                        res.on("end", () => resolve({
                            status: res.statusCode ?? 0,
                            body,
                            allowOrigin: res.headers["access-control-allow-origin"],
                        }));
                    },
                );

                req.on("error", reject);
                req.setTimeout(5_000, () => {
                    req.destroy(new Error("Test request timed out."));
                });
                req.end(method === "POST" ? packet : undefined);
            });
        }

        for (const site of ["cross-site", "same-site", "none", "invalid"]) {
            for (const method of ["POST", "GET"] as const) {
                const result = await send(method, site);
                assert.equal(result.status, 403);
                assert.deepEqual(JSON.parse(result.body), {
                    error: "CROSS_ORIGIN_REQUEST_BLOCKED",
                });
            }
        }

        assert.equal(writes, 0);
        assert.equal(reads, 0);
        console.log("PASS: disallowed browser contexts cannot write or read packets.");

        const preflight = await send("OPTIONS", "cross-site", false);
        assert.equal(preflight.status, 403);
        assert.equal(preflight.allowOrigin, undefined);
        console.log("PASS: cross-site preflight receives no CORS permission.");

        for (const site of ["same-origin", undefined]) {
            for (const method of ["POST", "GET"] as const) {
                const result = await send(method, site, false);
                assert.equal(result.status, 401);
            }
        }

        assert.equal(writes, 0);
        assert.equal(reads, 0);
        console.log("PASS: same-origin and headerless requests still require authentication.");

        assert.equal((await send("POST", "same-origin")).status, 202);
        assert.equal((await send("GET", "same-origin")).status, 404);
        assert.equal(writes, 1);
        assert.equal(reads, 1);
        console.log("PASS: authenticated same-origin requests reach the packet handlers.");

        assert.equal((await send("POST")).status, 202);
        assert.equal((await send("GET")).status, 404);
        assert.equal(writes, 2);
        assert.equal(reads, 2);
        console.log("PASS: authenticated CLI-style requests remain supported.");
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
            server.closeAllConnections();
        });
    }
}

try {
    await checkReceiverOrigin();
} catch (error) {
    console.error("Receiver origin check failed:", error);
    process.exitCode = 1;
}