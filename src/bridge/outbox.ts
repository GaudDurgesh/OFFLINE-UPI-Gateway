import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    validatePacket,
    type MeshPacket,
} from "../domain/packet.js";
import {
    validateGatewayResponse,
    type GatewayResponse,
} from "./gateway-response.js";
import { retryDelayMs } from "./retry-policy.js";

export type PendingPacket = {
    packetHash: string;
    packet: MeshPacket;
};

export type DeliveryPause = {
    reason: "AUTHENTICATION_FAILED" | "UNEXPECTED_HTTP_STATUS";
    httpStatus: number;
};

export const MAX_STORED_PACKETS = 10_000;
export const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class OutboxCapacityError extends Error {
    constructor() {
        super("Outbox storage capacity reached.");
        this.name = "OutboxCapacityError";
    }
}

export type PacketDeliveryStatus = {
    packetHash: string;
    deliveryStatus:
    | "NOT_FOUND"
    | "PENDING"
    | "RETRY_SCHEDULED"
    | "PAUSED"
    | "COMPLETED";
    response: GatewayResponse | null;
    retry: {
        attempts: number;
        nextAttemptAt: number;
    } | null;
    pause: DeliveryPause | null;
};

export class BridgeOutbox {
    private readonly database: DatabaseSync;

    constructor(directory = ".bridge-data") {
        const location = resolve(directory);

        mkdirSync(location, {
            recursive: true,
            mode: 0o700,
        });

        this.database = new DatabaseSync(
            resolve(location, "outbox.sqlite"),
        );

        try {
            this.database.exec(`
        PRAGMA busy_timeout = 3000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;

        CREATE TABLE IF NOT EXISTS outbox (
          packet_hash TEXT PRIMARY KEY,
          packet_json TEXT NOT NULL,
          queued_at INTEGER NOT NULL
        ) STRICT;
         
                 CREATE TABLE IF NOT EXISTS outbox_results (
          packet_hash TEXT PRIMARY KEY,
          response_json TEXT NOT NULL,
          completed_at INTEGER NOT NULL
        ) STRICT;

                CREATE TABLE IF NOT EXISTS outbox_retries (
          packet_hash TEXT PRIMARY KEY,
          attempts INTEGER NOT NULL CHECK (attempts >= 1),
          next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0)
        ) STRICT;

                CREATE TABLE IF NOT EXISTS outbox_pause (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          reason TEXT NOT NULL,
          http_status INTEGER NOT NULL
        ) STRICT;
      `);
        } catch (error) {
            this.database.close();
            throw error;
        }
    }

    enqueue(input: unknown): {
        packetHash: string;
        inserted: boolean;
    } {
        const validated = validatePacket(input);

        if (!validated.ok) {
            throw new Error("Cannot queue an invalid packet.");
        }

        // Keep duplicate lookup, capacity check, and insertion together.
        // Concurrent enqueue processes must not claim the same free slot.
        this.database.exec("BEGIN IMMEDIATE");

        try {
            const existing = this.database.prepare(`
                SELECT packet_hash
                FROM outbox
                WHERE packet_hash = ?
            `).get(validated.packetHash);

            if (existing) {
                this.database.exec("COMMIT");

                return {
                    packetHash: validated.packetHash,
                    inserted: false,
                };
            }

            const row = this.database.prepare(`
                SELECT COUNT(*) AS total
                FROM outbox
            `).get();

            if (
                !row ||
                typeof row.total !== "number" ||
                !Number.isSafeInteger(row.total) ||
                row.total < 0
            ) {
                throw new Error("Invalid outbox packet count.");
            }

            if (row.total >= MAX_STORED_PACKETS) {
                throw new OutboxCapacityError();
            }

            this.database.prepare(`
                INSERT INTO outbox (
                    packet_hash,
                    packet_json,
                    queued_at
                )
                VALUES (?, ?, ?)
            `).run(
                validated.packetHash,
                JSON.stringify(validated.packet),
                Date.now(),
            );

            this.database.exec("COMMIT");

            return {
                packetHash: validated.packetHash,
                inserted: true,
            };
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }

    listPending(limit = 100, nowMs = Date.now()): PendingPacket[] {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
            throw new Error("Invalid queue clock.");
        }
        if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 100
        ) {
            throw new Error("Batch size must be between 1 and 100.");
        }

        const rows = this.database.prepare(`
      SELECT o.packet_hash, o.packet_json
      FROM outbox AS o
      LEFT JOIN outbox_retries AS r
        ON r.packet_hash = o.packet_hash
      WHERE NOT EXISTS (
        SELECT 1
        FROM outbox_results
        WHERE outbox_results.packet_hash = o.packet_hash
      )
      AND (
        r.next_attempt_at IS NULL
        OR r.next_attempt_at <= ?
      )
      ORDER BY o.queued_at, o.packet_hash
      LIMIT ?
    `).all(nowMs, limit);

        return rows.map((row) => {
            if (
                typeof row.packet_hash !== "string" ||
                typeof row.packet_json !== "string"
            ) {
                throw new Error("Invalid outbox record.");
            }

            const validated = validatePacket(
                JSON.parse(row.packet_json),
            );

            if (
                !validated.ok ||
                validated.packetHash !== row.packet_hash
            ) {
                throw new Error("Stored packet failed validation.");
            }

            return {
                packetHash: validated.packetHash,
                packet: validated.packet,
            };
        });
    }

    markCompleted(
        packetHash: string,
        response: unknown,
    ): void {
        const checked = validateGatewayResponse(response, packetHash);

        if (!checked.ok) {
            throw new Error("Cannot store an invalid gateway response.");
        }

        // Only complete a packet that exists in this outbox.
        // Preserve the first saved result on repeated completion.
        const result = this.database.prepare(`
      INSERT INTO outbox_results (
        packet_hash,
        response_json,
        completed_at
      )
      SELECT packet_hash, ?, ?
      FROM outbox
      WHERE packet_hash = ?
      ON CONFLICT (packet_hash) DO NOTHING
    `).run(
            JSON.stringify(checked.response),
            Date.now(),
            packetHash,
        );

        if (Number(result.changes) === 0) {
            const existing = this.database.prepare(`
        SELECT packet_hash
        FROM outbox_results
        WHERE packet_hash = ?
      `).get(packetHash);

            if (!existing) {
                throw new Error("Cannot complete an unknown packet.");
            }
        }
    }

    getCompleted(packetHash: string): GatewayResponse | null {
        const row = this.database.prepare(`
      SELECT response_json
      FROM outbox_results
      WHERE packet_hash = ?
    `).get(packetHash);

        if (!row) {
            return null;
        }

        if (typeof row.response_json !== "string") {
            throw new Error("Invalid stored gateway response.");
        }

        const checked = validateGatewayResponse(
            JSON.parse(row.response_json),
            packetHash,
        );

        if (!checked.ok) {
            throw new Error("Stored gateway response failed validation.");
        }

        return checked.response;
    }

    getRetryState(packetHash: string): {
        attempts: number;
        nextAttemptAt: number;
    } | null {
        const row = this.database.prepare(`
      SELECT attempts, next_attempt_at
      FROM outbox_retries
      WHERE packet_hash = ?
    `).get(packetHash);

        if (!row) {
            return null;
        }

        if (
            typeof row.attempts !== "number" ||
            !Number.isSafeInteger(row.attempts) ||
            row.attempts < 1 ||
            typeof row.next_attempt_at !== "number" ||
            !Number.isSafeInteger(row.next_attempt_at) ||
            row.next_attempt_at < 0
        ) {
            throw new Error("Invalid stored retry state.");
        }

        return {
            attempts: row.attempts,
            nextAttemptAt: row.next_attempt_at,
        };
    }

    scheduleRetry(
        packetHash: string,
        retryAfter: string | null = null,
        nowMs = Date.now(),
        random = Math.random(),
    ): {
        attempts: number;
        nextAttemptAt: number;
    } {
        this.database.exec("BEGIN IMMEDIATE");

        try {
            const pending = this.database.prepare(`
        SELECT packet_hash
        FROM outbox
        WHERE packet_hash = ?
        AND NOT EXISTS (
          SELECT 1
          FROM outbox_results
          WHERE outbox_results.packet_hash = outbox.packet_hash
        )
      `).get(packetHash);

            if (!pending) {
                throw new Error("Cannot retry an unknown or completed packet.");
            }

            const previous = this.getRetryState(packetHash);
            const attempts = (previous?.attempts ?? 0) + 1;

            const delayMs = retryDelayMs(
                attempts,
                retryAfter,
                nowMs,
                random,
            );

            // A duplicate scheduling call must not shorten an existing wait.
            const nextAttemptAt = Math.max(
                previous?.nextAttemptAt ?? 0,
                nowMs + delayMs,
            );

            this.database.prepare(`
        INSERT INTO outbox_retries (
          packet_hash,
          attempts,
          next_attempt_at
        )
        VALUES (?, ?, ?)
        ON CONFLICT (packet_hash) DO UPDATE SET
          attempts = excluded.attempts,
          next_attempt_at = excluded.next_attempt_at
      `).run(packetHash, attempts, nextAttemptAt);

            this.database.exec("COMMIT");

            return { attempts, nextAttemptAt };
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }

    getDeliveryPause(): DeliveryPause | null {
        const row = this.database.prepare(`
      SELECT reason, http_status
      FROM outbox_pause
      WHERE id = 1
    `).get();

        if (!row) {
            return null;
        }

        if (
            (
                row.reason !== "AUTHENTICATION_FAILED" &&
                row.reason !== "UNEXPECTED_HTTP_STATUS"
            ) ||
            typeof row.http_status !== "number" ||
            !Number.isInteger(row.http_status) ||
            row.http_status < 100 ||
            row.http_status > 599
        ) {
            throw new Error("Invalid stored delivery pause.");
        }

        return {
            reason: row.reason,
            httpStatus: row.http_status,
        };
    }

    pauseDelivery(pause: DeliveryPause): void {
        if (
            (
                pause.reason !== "AUTHENTICATION_FAILED" &&
                pause.reason !== "UNEXPECTED_HTTP_STATUS"
            ) ||
            !Number.isInteger(pause.httpStatus) ||
            pause.httpStatus < 100 ||
            pause.httpStatus > 599
        ) {
            throw new Error("Invalid delivery pause.");
        }

        this.database.prepare(`
      INSERT INTO outbox_pause (id, reason, http_status)
      VALUES (1, ?, ?)
      ON CONFLICT (id) DO NOTHING
    `).run(pause.reason, pause.httpStatus);
    }

    resumeDelivery(): void {
        this.database.prepare(`
      DELETE FROM outbox_pause WHERE id = 1
    `).run();
    }

    getPacketStatus(
        packetHash: string,
        nowMs = Date.now(),
    ): PacketDeliveryStatus {
        if (!/^[0-9a-f]{64}$/.test(packetHash)) {
            throw new Error("Invalid packet hash.");
        }

        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
            throw new Error("Invalid lookup clock.");
        }

        // Read packet, outcome, retry, and pause from one snapshot.
        this.database.exec("BEGIN");

        try {
            const status: PacketDeliveryStatus = {
                packetHash,
                deliveryStatus: "NOT_FOUND",
                response: null,
                retry: null,
                pause: null,
            };

            const existing = this.database.prepare(`
                SELECT packet_hash
                FROM outbox
                WHERE packet_hash = ?
            `).get(packetHash);

            if (existing) {
                const response = this.getCompleted(packetHash);

                if (response) {
                    status.deliveryStatus = "COMPLETED";
                    status.response = response;
                } else {
                    status.retry = this.getRetryState(packetHash);
                    status.pause = this.getDeliveryPause();

                    if (status.pause) {
                        status.deliveryStatus = "PAUSED";
                    } else if (
                        status.retry &&
                        status.retry.nextAttemptAt > nowMs
                    ) {
                        status.deliveryStatus = "RETRY_SCHEDULED";
                    } else {
                        status.deliveryStatus = "PENDING";
                    }
                }
            }

            this.database.exec("COMMIT");
            return status;
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }

    getSummary(nowMs = Date.now()) {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
            throw new Error("Invalid queue clock.");
        }

        const row = this.database.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(result.packet_hash) AS completed,
        COALESCE(SUM(
          CASE
            WHEN result.packet_hash IS NULL
              AND (
                retry.next_attempt_at IS NULL
                OR retry.next_attempt_at <= ?
              )
            THEN 1
            ELSE 0
          END
        ), 0) AS due
      FROM outbox AS packet
      LEFT JOIN outbox_results AS result
        ON result.packet_hash = packet.packet_hash
      LEFT JOIN outbox_retries AS retry
        ON retry.packet_hash = packet.packet_hash
    `).get(nowMs);

        if (
            !row ||
            typeof row.total !== "number" ||
            typeof row.completed !== "number" ||
            typeof row.due !== "number" ||
            !Number.isSafeInteger(row.total) ||
            !Number.isSafeInteger(row.completed) ||
            !Number.isSafeInteger(row.due)
        ) {
            throw new Error("Invalid queue summary.");
        }

        const pending = row.total - row.completed;

        if (
            row.completed < 0 ||
            pending < 0 ||
            row.due < 0 ||
            row.due > pending
        ) {
            throw new Error("Inconsistent queue summary.");
        }

        return {
            total: row.total,
            completed: row.completed,
            pending,
            due: row.due,
            scheduled: pending - row.due,
            pause: this.getDeliveryPause(),
        };
    }

    pruneCompleted(limit = 100, nowMs = Date.now()): number {
        if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 1000
        ) {
            throw new Error("Cleanup batch size must be between 1 and 1000.");
        }

        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
            throw new Error("Invalid cleanup clock.");
        }

        const cutoff = nowMs - COMPLETED_RETENTION_MS;

        if (cutoff < 0) {
            return 0;
        }

        this.database.exec("BEGIN IMMEDIATE");

        try {
            const rows = this.database.prepare(`
                SELECT packet.packet_hash
                FROM outbox AS packet
                INNER JOIN outbox_results AS result
                    ON result.packet_hash = packet.packet_hash
                WHERE result.completed_at <= ?
                ORDER BY result.completed_at, packet.packet_hash
                LIMIT ?
            `).all(cutoff, limit);

            const deleteRetry = this.database.prepare(`
                DELETE FROM outbox_retries WHERE packet_hash = ?
            `);

            const deleteResult = this.database.prepare(`
                DELETE FROM outbox_results WHERE packet_hash = ?
            `);

            const deletePacket = this.database.prepare(`
                DELETE FROM outbox WHERE packet_hash = ?
            `);

            for (const row of rows) {
                if (typeof row.packet_hash !== "string") {
                    throw new Error("Invalid cleanup record.");
                }

                deleteRetry.run(row.packet_hash);

                const result = deleteResult.run(row.packet_hash);
                const packet = deletePacket.run(row.packet_hash);

                if (
                    Number(result.changes) !== 1 ||
                    Number(packet.changes) !== 1
                ) {
                    throw new Error("Cleanup did not remove the expected records.");
                }
            }

            this.database.exec("COMMIT");
            return rows.length;
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }

    close(): void {
        this.database.close();
    }
}