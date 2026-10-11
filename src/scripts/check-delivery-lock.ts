import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireDeliveryLock } from "../bridge/delivery-lock.js";
import { BridgeOutbox } from "../bridge/outbox.js";

const moduleUrl = pathToFileURL(
  resolve("src/bridge/delivery-lock.ts"),
).href;

const childSource = `
  import { acquireDeliveryLock } from ${JSON.stringify(moduleUrl)};

  try {
    const release = acquireDeliveryLock(process.env.LOCK_TEST_DIR);

    if (process.env.LOCK_TEST_HOLD === "1") {
      process.stdout.write("LOCKED\\n");
      setInterval(() => {}, 1000);
    } else {
      release();
    }
  } catch {
    process.exitCode = 2;
  }
`;

function probe(directory: string): number | null {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childSource],
    {
      env: {
        ...process.env,
        LOCK_TEST_DIR: directory,
        LOCK_TEST_HOLD: "0",
      },
      timeout: 10_000,
      encoding: "utf8",
    },
  );

  assert.equal(result.error, undefined, "Lock probe could not finish.");
  assert.equal(result.signal, null, "Lock probe was interrupted.");

  return result.status;
}

async function checkDeliveryLock() {
  const directory = await mkdtemp(
    join(tmpdir(), "bridge-lock-check-"),
  );

  let release: (() => void) | undefined;

  try {
    release = acquireDeliveryLock(directory);

    assert.equal(probe(directory), 2);
    console.log("PASS: another process cannot acquire the held lock.");

    const outbox = new BridgeOutbox(directory);

    try {
      const result = outbox.enqueue({
        packetId: randomUUID(),
        ttl: 5,
        createdAt: Date.now(),
        ciphertext: Buffer.alloc(285, 13).toString("base64"),
      });

      assert.equal(result.inserted, true);
      assert.equal(outbox.getSummary().pending, 1);
    } finally {
      outbox.close();
    }

    console.log("PASS: delivery lock does not block outbox operations.");

    release();
    release();
    release = undefined;

    assert.equal(probe(directory), 0);
    console.log("PASS: repeated release is safe and another process can acquire.");

    const holder = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childSource],
      {
        env: {
          ...process.env,
          LOCK_TEST_DIR: directory,
          LOCK_TEST_HOLD: "1",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    // Observe process closure before sending any termination signal.
    const closed = new Promise<void>((resolveClosed) => {
      holder.once("close", () => resolveClosed());
    });

    try {
      await new Promise<void>((resolveReady, reject) => {
        let output = "";

        const timer = setTimeout(() => {
          reject(new Error("Lock holder did not become ready."));
        }, 10_000);

        holder.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Could not start lock holder."));
        });

        holder.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Lock holder exited before readiness."));
        });

        holder.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");

          if (output.includes("LOCKED\n")) {
            clearTimeout(timer);
            resolveReady();
          }
        });
      });

      assert.equal(probe(directory), 2);
      console.log("PASS: child process retains the lock while running.");
    } finally {
      holder.kill("SIGKILL");
      await closed;
    }

    assert.equal(probe(directory), 0);
    console.log("PASS: forced termination releases the lock without deleting its file.");

    release = acquireDeliveryLock(directory);
    release();
    release = undefined;

    console.log("PASS: normal acquisition still works after forced termination.");
  } finally {
    try {
      release?.();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    console.log("Temporary lock directory removed.");
  }
}

try {
  await checkDeliveryLock();
} catch (error) {
  console.error("Delivery lock check failed:", error);
  process.exitCode = 1;
}