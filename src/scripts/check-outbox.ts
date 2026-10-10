import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeOutbox } from "../bridge/outbox.js";

async function checkOutbox() {
    const directory = await mkdtemp(
        join(tmpdir(), "gateway-outbox-check-"),
    );

    let outbox: BridgeOutbox | undefined;

    try {
        outbox = new BridgeOutbox(directory);

        // Structurally valid test bytes, not a real encrypted payment.
        // This check tests storage; the gateway validates encryption.
        const packet = {
            packetId: randomUUID(),
            ttl: 5,
            createdAt: Date.now(),
            ciphertext: Buffer.alloc(285, 1).toString("base64"),
        };

        const first = outbox.enqueue(packet);

        assert.equal(first.inserted, true);
        assert.deepEqual(outbox.listPending(), [
            { packetHash: first.packetHash, packet },
        ]);

        console.log("PASS: packet stored without changing its contents.");

        const duplicate = outbox.enqueue(packet);

        assert.equal(duplicate.inserted, false);
        assert.equal(duplicate.packetHash, first.packetHash);
        assert.equal(outbox.listPending().length, 1);

        console.log("PASS: duplicate packet creates no extra entry.");

        const metadataChange = outbox.enqueue({
            ...packet,
            packetId: randomUUID(),
            ttl: 4,
            createdAt: packet.createdAt + 1,
        });

        assert.equal(metadataChange.inserted, false);
        assert.deepEqual(outbox.listPending()[0]?.packet, packet);

        console.log("PASS: relay metadata changes preserve the original entry.");

        assert.throws(
            () => outbox!.enqueue({ ...packet, ciphertext: "invalid" }),
            /Cannot queue an invalid packet/,
        );
        assert.equal(outbox.listPending().length, 1);

        console.log("PASS: invalid packet rejected without changing the queue.");

        outbox.close();
        outbox = undefined;
        outbox = new BridgeOutbox(directory);

        assert.deepEqual(outbox.listPending(), [
            { packetHash: first.packetHash, packet },
        ]);
        assert.equal(outbox.enqueue(packet).inserted, false);

        console.log("PASS: packet and duplicate protection survive reopening.");

        const second = outbox.enqueue({
            ...packet,
            packetId: randomUUID(),
            ciphertext: Buffer.alloc(285, 2).toString("base64"),
        });

        assert.equal(second.inserted, true);
        assert.notEqual(second.packetHash, first.packetHash);
        assert.equal(outbox.listPending().length, 2);
        assert.equal(outbox.listPending(1).length, 1);

        for (const limit of [0, -1, 101, 1.5, NaN]) {
            assert.throws(
                () => outbox!.listPending(limit),
                /Batch size must be between 1 and 100/,
            );
        }

        console.log("PASS: distinct packets stored and batch limits enforced.");
        const settledResponse = {
            packetHash: first.packetHash,
            repeated: false,
            outcome: {
                status: "SETTLED",
                transactionId: "123",
            },
        };

        assert.equal(outbox.getCompleted(first.packetHash), null);

        outbox.markCompleted(first.packetHash, settledResponse);

        assert.deepEqual(
            outbox.getCompleted(first.packetHash),
            settledResponse,
        );

        assert.deepEqual(
            outbox.listPending().map((entry) => entry.packetHash),
            [second.packetHash],
        );

        console.log("PASS: completion stores the result and removes pending work.");

        outbox.markCompleted(first.packetHash, {
            ...settledResponse,
            repeated: true,
            outcome: {
                status: "DUPLICATE",
                transactionId: "123",
            },
        });

        assert.deepEqual(
            outbox.getCompleted(first.packetHash),
            settledResponse,
        );

        assert.equal(outbox.enqueue(packet).inserted, false);
        assert.equal(outbox.listPending().length, 1);

        console.log("PASS: repeated completion preserves the first saved result.");

        assert.throws(
            () => outbox!.markCompleted(second.packetHash, settledResponse),
            /Cannot store an invalid gateway response/,
        );

        assert.throws(
            () => outbox!.markCompleted(second.packetHash, {
                packetHash: second.packetHash,
                repeated: false,
                outcome: { status: "PROCESSING" },
            }),
            /Cannot store an invalid gateway response/,
        );

        assert.equal(outbox.getCompleted(second.packetHash), null);
        assert.equal(outbox.listPending().length, 1);

        console.log("PASS: invalid completion leaves the packet pending.");

        const unknownHash = "f".repeat(64);

        assert.notEqual(first.packetHash, unknownHash);
        assert.notEqual(second.packetHash, unknownHash);

        assert.throws(
            () => outbox!.markCompleted(unknownHash, {
                ...settledResponse,
                packetHash: unknownHash,
            }),
            /Cannot complete an unknown packet/,
        );

        assert.equal(outbox.getCompleted(unknownHash), null);

        console.log("PASS: unknown packets cannot receive stored outcomes.");

        const rejectedResponse = {
            packetHash: second.packetHash,
            repeated: false,
            outcome: {
                status: "REJECTED",
                reason: "INSUFFICIENT_FUNDS",
            },
        };

        outbox.markCompleted(second.packetHash, rejectedResponse);

        assert.deepEqual(
            outbox.getCompleted(second.packetHash),
            rejectedResponse,
        );
        assert.equal(outbox.listPending().length, 0);

        console.log("PASS: rejected payments finish delivery without becoming settled.");

        outbox.close();
        outbox = undefined;
        outbox = new BridgeOutbox(directory);

        assert.equal(outbox.listPending().length, 0);
        assert.deepEqual(
            outbox.getCompleted(first.packetHash),
            settledResponse,
        );
        assert.deepEqual(
            outbox.getCompleted(second.packetHash),
            rejectedResponse,
        );

        assert.equal(outbox.enqueue(packet).inserted, false);
        assert.equal(outbox.listPending().length, 0);

        console.log("PASS: completed outcomes and duplicate protection survive reopening.");
    } finally {
        try {
            outbox?.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }

        console.log("Temporary outbox removed.");
    }
}

try {
    await checkOutbox();
} catch (error) {
    console.error("Outbox check failed:", error);
    process.exitCode = 1;
}