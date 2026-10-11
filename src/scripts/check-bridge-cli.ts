import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateBridgeKey } from "../crypto/bridge-keys.js";
import { validatePacket } from "../domain/packet.js";
import { BridgeOutbox } from "../bridge/outbox.js";

type CommandResult = {
    code: number;
    stdout: string;
    stderr: string;
};

function runCommand(
    script: string,
    args: string[],
    directory: string,
): Promise<CommandResult> {
    return new Promise((resolveResult, reject) => {
        execFile(
            process.execPath,
            ["--import", "tsx", resolve("src/scripts", script), ...args],
            {
                env: { ...process.env, BRIDGE_DATA_DIR: directory },
                timeout: 20_000,
                maxBuffer: 64 * 1024,
            },
            (error, stdout, stderr) => {
                if (error && (error.killed || typeof error.code !== "number")) {
                    reject(new Error("Test command could not finish."));
                    return;
                }

                resolveResult({
                    code: error && typeof error.code === "number" ? error.code : 0,
                    stdout,
                    stderr,
                });
            },
        );
    });
}

async function checkBridgeCli() {
    const root = await mkdtemp(join(tmpdir(), "bridge-cli-check-"));
    const apiKey = generateBridgeKey();
    const credentialFile = join(root, "credentials.json");
    const packetFile = join(root, "packet.json");

    const packet = {
        packetId: randomUUID(),
        ttl: 5,
        createdAt: Date.now(),
        ciphertext: Buffer.alloc(285, 11).toString("base64"),
    };

    const validated = validatePacket(packet);
    assert.ok(validated.ok);

    let responseStatus = 200;
    let requests = 0;

    const server = createServer((req, res) => {
        req.resume();

        req.on("end", () => {
            requests += 1;

            if (
                req.method !== "POST" ||
                req.url !== "/api/bridge/ingest" ||
                req.headers.authorization !== `Bearer ${apiKey}`
            ) {
                res.writeHead(401);
                res.end();
                return;
            }

            res.writeHead(responseStatus, {
                "Content-Type": "application/json",
                "Retry-After": "2",
            });

            res.end(JSON.stringify(
                responseStatus === 200
                    ? {
                        packetHash: validated.packetHash,
                        repeated: false,
                        outcome: {
                            status: "SETTLED",
                            transactionId: "123",
                        },
                    }
                    : { error: "TEST_FAILURE" },
            ));
        });

        req.on("error", () => res.destroy());
    });

    try {
        await writeFile(
            credentialFile,
            JSON.stringify({ apiKey }),
            { flag: "wx", mode: 0o600 },
        );
        await writeFile(packetFile, JSON.stringify(packet));

        await new Promise<void>((resolveReady, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolveReady);
        });

        const address = server.address();
        assert.ok(address && typeof address !== "string");

        const origin = `http://127.0.0.1:${address.port}`;
        const deliveryArgs = [origin, credentialFile];
        const mainQueue = join(root, "main");

        async function command(
            script: string,
            args: string[],
            directory: string,
        ) {
            const result = await runCommand(script, args, directory);

            assert.equal(result.stdout.includes(apiKey), false);
            assert.equal(result.stderr.includes(apiKey), false);
            assert.equal(result.stdout.includes(packet.ciphertext), false);
            assert.equal(result.stderr.includes(packet.ciphertext), false);

            return result;
        }

        const first = await command(
            "bridge-enqueue.ts", [packetFile], mainQueue,
        );
        const duplicate = await command(
            "bridge-enqueue.ts", [packetFile], mainQueue,
        );

        assert.equal(first.code, 0);
        assert.equal(duplicate.code, 0);
        assert.equal(JSON.parse(first.stdout).event, "packet_queued");
        assert.equal(
            JSON.parse(duplicate.stdout).event,
            "packet_already_known",
        );

        const initialStatus = await command(
            "bridge-status.ts", [], mainQueue,
        );
        assert.equal(initialStatus.code, 0);
        assert.deepEqual(JSON.parse(initialStatus.stdout), {
            total: 1,
            completed: 0,
            pending: 1,
            due: 1,
            scheduled: 0,
            pause: null,
        });

        console.log("PASS: enqueue, duplicate detection, and status commands work.");

        const delivered = await command(
            "bridge-deliver-once.ts", deliveryArgs, mainQueue,
        );

        assert.equal(delivered.code, 0);
        assert.equal(JSON.parse(delivered.stdout).status, "COMPLETED");

        const callsAfterDelivery = requests;
        const idle = await command(
            "bridge-deliver-once.ts", deliveryArgs, mainQueue,
        );

        assert.equal(idle.code, 0);
        assert.equal(JSON.parse(idle.stdout).status, "IDLE");
        assert.equal(requests, callsAfterDelivery);

        const finalStatus = await command(
            "bridge-status.ts", [], mainQueue,
        );
        assert.equal(finalStatus.code, 0);
        assert.equal(JSON.parse(finalStatus.stdout).completed, 1);
        assert.equal(JSON.parse(finalStatus.stdout).pending, 0);

        console.log("PASS: completed delivery returns zero and is not resent.");

        const retryQueue = join(root, "retry");
        assert.equal(
            (await command("bridge-enqueue.ts", [packetFile], retryQueue)).code,
            0,
        );

        responseStatus = 503;

        const retry = await command(
            "bridge-deliver-once.ts", deliveryArgs, retryQueue,
        );

        assert.equal(retry.code, 2);
        assert.equal(JSON.parse(retry.stdout).status, "RETRY");

        const retryOutbox = new BridgeOutbox(retryQueue);
        try {
            assert.equal(
                retryOutbox.getRetryState(validated.packetHash)?.attempts,
                1,
            );
            assert.equal(retryOutbox.getCompleted(validated.packetHash), null);
        } finally {
            retryOutbox.close();
        }

        console.log("PASS: temporary failure returns two and saves retry state.");

        const pausedQueue = join(root, "paused");
        assert.equal(
            (await command("bridge-enqueue.ts", [packetFile], pausedQueue)).code,
            0,
        );

        responseStatus = 401;

        const paused = await command(
            "bridge-deliver-once.ts", deliveryArgs, pausedQueue,
        );

        assert.equal(paused.code, 3);
        assert.equal(JSON.parse(paused.stdout).status, "PAUSED");

        const callsAtPause = requests;
        const stillPaused = await command(
            "bridge-deliver-once.ts", deliveryArgs, pausedQueue,
        );

        assert.equal(stillPaused.code, 3);
        assert.equal(requests, callsAtPause);

        console.log("PASS: authentication pause survives separate command runs.");

        responseStatus = 200;

        const resumed = await command(
            "bridge-resume.ts", [], pausedQueue,
        );

        assert.equal(resumed.code, 0);
        assert.equal(JSON.parse(resumed.stdout).event, "bridge_resumed");
        assert.equal(requests, callsAtPause);

        const resumedAgain = await command(
            "bridge-resume.ts", [], pausedQueue,
        );

        assert.equal(resumedAgain.code, 0);
        assert.equal(
            JSON.parse(resumedAgain.stdout).event,
            "bridge_not_paused",
        );
        assert.equal(requests, callsAtPause);

        const afterResume = await command(
            "bridge-deliver-once.ts", deliveryArgs, pausedQueue,
        );

        assert.equal(afterResume.code, 0);
        assert.equal(JSON.parse(afterResume.stdout).status, "COMPLETED");
        assert.equal(requests, callsAtPause + 1);

        console.log("PASS: resume is repeatable and delivery requires a separate command.");

        const beforeInvalid = requests;
        const invalid = await command(
            "bridge-deliver-once.ts", [], mainQueue,
        );

        assert.equal(invalid.code, 1);
        assert.equal(requests, beforeInvalid);

        console.log("PASS: missing arguments return one without a request.");
        console.log("PASS: command output contains no API key or ciphertext.");
    } finally {
        try {
            if (server.listening) {
                await new Promise<void>((resolveClosed, reject) => {
                    server.close((error) => {
                        if (error) reject(error);
                        else resolveClosed();
                    });
                    server.closeAllConnections();
                });
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }

        console.log("Temporary CLI files, queues, and server removed.");
    }
}

try {
    await checkBridgeCli();
} catch {
    console.error("Bridge CLI check failed.");
    process.exitCode = 1;
}