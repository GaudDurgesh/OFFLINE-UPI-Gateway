import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    BridgeOutbox,
    COMPLETED_RETENTION_MS,
} from "../bridge/outbox.js";

async function checkRetention() {
    const root = await mkdtemp(join(tmpdir(), "outbox-retention-check-"));
    let outbox: BridgeOutbox | undefined;
    let fixtureDatabase: DatabaseSync | undefined;

    try {
        outbox = new BridgeOutbox(root);
        fixtureDatabase = new DatabaseSync(join(root, "outbox.sqlite"));

        const now = Date.now();
        const cutoff = now - COMPLETED_RETENTION_MS;

        function makePacket(seed: number) {
            return {
                packetId: randomUUID(),
                ttl: 5,
                createdAt: now,
                ciphertext: Buffer.alloc(285, seed).toString("base64"),
            };
        }

        const packets = [1, 2, 3, 4].map(makePacket);
        const hashes = packets.map(
            (packet) => outbox!.enqueue(packet).packetHash,
        );

        const [oldHash, boundaryHash, recentHash, pendingHash] = hashes;
        assert.ok(oldHash && boundaryHash && recentHash && pendingHash);

        // Give every packet retry state to check which records are retained.
        for (const hash of hashes) {
            outbox.scheduleRetry(hash, "60", now, 0);
        }

        const pendingRetry = outbox.getRetryState(pendingHash);
        const boundaryRetry = outbox.getRetryState(boundaryHash);

        function complete(hash: string, transactionId: string) {
            outbox!.markCompleted(hash, {
                packetHash: hash,
                repeated: false,
                outcome: { status: "SETTLED", transactionId },
            });
        }

        complete(oldHash, "1");
        complete(boundaryHash, "2");
        complete(recentHash, "3");

        const boundaryOutcome = outbox.getCompleted(boundaryHash);
        const recentOutcome = outbox.getCompleted(recentHash);

        // Set controlled completion times only in this temporary fixture.
        const setTime = fixtureDatabase.prepare(`
      UPDATE outbox_results
      SET completed_at = ?
      WHERE packet_hash = ?
    `);

        setTime.run(cutoff - 1, oldHash);
        setTime.run(cutoff, boundaryHash);
        setTime.run(cutoff + 1, recentHash);

        // Even a very old pending packet must remain.
        fixtureDatabase.prepare(`
      UPDATE outbox SET queued_at = 0 WHERE packet_hash = ?
    `).run(pendingHash);

        assert.equal(outbox.pruneCompleted(100, now - 2), 0);
        assert.equal(outbox.getSummary(now).total, 4);

        console.log("PASS: completed packets remain before the retention boundary.");

        assert.equal(outbox.pruneCompleted(1, now), 1);
        assert.equal(outbox.getCompleted(oldHash), null);
        assert.deepEqual(
            outbox.getCompleted(boundaryHash),
            boundaryOutcome,
        );
        assert.equal(outbox.getSummary(now).total, 3);

        console.log("PASS: cleanup respects its batch limit and removes the oldest first.");

        const beforeFailure = outbox.getSummary(now);

        // Failure occurs after the method has deleted retry and result records.
        fixtureDatabase.exec(`
      CREATE TRIGGER fail_retention_delete
      BEFORE DELETE ON outbox
      BEGIN
        SELECT RAISE(ABORT, 'forced retention failure');
      END;
    `);

        try {
            assert.throws(() => outbox!.pruneCompleted(100, now));

            assert.deepEqual(outbox.getSummary(now), beforeFailure);
            assert.deepEqual(
                outbox.getCompleted(boundaryHash),
                boundaryOutcome,
            );
            assert.deepEqual(
                outbox.getRetryState(boundaryHash),
                boundaryRetry,
            );
        } finally {
            fixtureDatabase.exec("DROP TRIGGER fail_retention_delete");
        }

        console.log("PASS: failed cleanup rolls back packets, outcomes, and retry records.");

        assert.equal(outbox.pruneCompleted(100, now), 1);
        assert.equal(outbox.getCompleted(boundaryHash), null);
        assert.deepEqual(outbox.getCompleted(recentHash), recentOutcome);
        assert.deepEqual(outbox.getRetryState(pendingHash), pendingRetry);

        assert.deepEqual(
            outbox.listPending(100, now + 60_000).map((entry) => entry.packetHash),
            [pendingHash],
        );

        assert.equal(outbox.getSummary(now).total, 2);
        assert.equal(outbox.getSummary(now).pending, 1);
        assert.equal(outbox.getSummary(now).completed, 1);

        console.log("PASS: exact-boundary cleanup preserves recent results and pending packets.");

        for (const hash of [oldHash, boundaryHash]) {
            for (const table of ["outbox", "outbox_results", "outbox_retries"]) {
                const row: Record<string, unknown> | undefined =
                    fixtureDatabase.prepare(
                        `SELECT COUNT(*) AS total FROM ${table} WHERE packet_hash = ?`,
                    ).get(hash);

                assert.equal(row?.total, 0);
            }
        }

        console.log("PASS: cleanup removes associated retry and outcome records.");

        fixtureDatabase.close();
        fixtureDatabase = undefined;
        outbox.close();
        outbox = new BridgeOutbox(root);

        assert.equal(outbox.getSummary(now).total, 2);
        assert.deepEqual(outbox.getCompleted(recentHash), recentOutcome);
        assert.equal(outbox.enqueue(packets[2]!).inserted, false);
        assert.equal(outbox.enqueue(packets[3]!).inserted, false);

        // A removed local duplicate record allows admission again.
        assert.equal(outbox.enqueue(packets[0]!).inserted, true);
        assert.equal(outbox.getCompleted(oldHash), null);

        console.log("PASS: cleanup survives reopening and only removed packets can re-enter.");

        const beforeInvalid = outbox.getSummary(now);

        for (const limit of [0, -1, 1.5, 1001, NaN]) {
            assert.throws(() => outbox!.pruneCompleted(limit, now));
        }

        for (const clock of [-1, 1.5, NaN, Infinity]) {
            assert.throws(() => outbox!.pruneCompleted(100, clock));
        }

        assert.deepEqual(outbox.getSummary(now), beforeInvalid);

        console.log("PASS: invalid cleanup arguments leave the queue unchanged.");
    } finally {
        try {
            fixtureDatabase?.close();
        } finally {
            try {
                outbox?.close();
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }

        console.log("Temporary retention queue removed.");
    }
}

try {
    await checkRetention();
} catch (error) {
    console.error("Outbox retention check failed:", error);
    process.exitCode = 1;
}