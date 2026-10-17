import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { generateBridgeKey } from "../crypto/bridge-keys.js";
import { BridgeOutbox } from "../bridge/outbox.js";
import { acquireDeliveryLock } from "../bridge/delivery-lock.js";

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition.");
    }

    await sleep(25);
  }
}

function startRunner(
  directory: string,
  origin: string,
  credentialFile: string,
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("src/scripts/bridge-run.ts"),
      origin,
      credentialFile,
    ],
    {
      env: { ...process.env, BRIDGE_DATA_DIR: directory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let finished = false;
  let spawnFailed = false;

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  child.on("error", () => {
    spawnFailed = true;
  });

  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClosed) => {
    child.once("close", (code, signal) => {
      finished = true;
      resolveClosed({ code, signal });
    });
  });

  return {
    child,
    closed,
    output: () => output,
    finished: () => finished,
    spawnFailed: () => spawnFailed,
  };
}

async function checkBridgeRunner() {
  const root = await mkdtemp(join(tmpdir(), "bridge-runner-check-"));
  const queueDirectory = join(root, "queue");
  const credentialFile = join(root, "credentials.json");
  const apiKey = generateBridgeKey();

  const runners: ReturnType<typeof startRunner>[] = [];

  let heldResponse: ServerResponse | undefined;
  let requests = 0;
  let stage = "setup";

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

      // Keep the first delivery active until the test releases it.
      if (heldResponse) {
        res.writeHead(503);
        res.end();
        return;
      }

      heldResponse = res;
    });

    req.on("error", () => res.destroy());
  });

  function makePacket(seed: number) {
    return {
      packetId: randomUUID(),
      ttl: 5,
      createdAt: Date.now(),
      ciphertext: Buffer.alloc(285, seed).toString("base64"),
    };
  }

  try {

    const firstPacket = makePacket(21);
    const secondPacket = makePacket(22);

    const initial = new BridgeOutbox(queueDirectory);
    let firstHash: string;

    try {
      firstHash = initial.enqueue(firstPacket).packetHash;
    } finally {
      initial.close();
    }

    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveReady);
    });

    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    await writeFile(
      credentialFile,
      JSON.stringify({ apiKey, gatewayOrigin: origin }),
      { flag: "wx", mode: 0o600 },
    );

    stage = "runner startup";
    const active = startRunner(queueDirectory, origin, credentialFile);
    runners.push(active);

    await waitFor(() => heldResponse !== undefined || active.finished());
    assert.equal(active.spawnFailed(), false);
    assert.equal(active.finished(), false);
    assert.ok(heldResponse);

    stage = "competing runner";
    const competitor = startRunner(queueDirectory, origin, credentialFile);
    runners.push(competitor);

    await waitFor(competitor.finished);
    const competitorExit = await competitor.closed;

    assert.equal(competitorExit.code, 1);
    assert.equal(requests, 1);

    console.log("PASS: competing runner exits without sending a request.");

    const writer = new BridgeOutbox(queueDirectory);
    let secondHash: string;

    try {
      secondHash = writer.enqueue(secondPacket).packetHash;
    } finally {
      writer.close();
    }

    stage = "shutdown during delivery";
    assert.equal(active.child.kill("SIGTERM"), true);

    await waitFor(() =>
      active.output().includes('"event":"bridge_stopping"') ||
      active.finished(),
    );

    assert.equal(active.finished(), false);

    heldResponse.writeHead(200, {
      "Content-Type": "application/json",
    });

    heldResponse.end(JSON.stringify({
      packetHash: firstHash,
      repeated: false,
      outcome: {
        status: "SETTLED",
        transactionId: "123",
      },
    }));

    await waitFor(active.finished);
    const activeExit = await active.closed;

    assert.equal(activeExit.code, 0);
    assert.equal(activeExit.signal, null);
    assert.ok(active.output().includes('"event":"bridge_stopped"'));

    const saved = new BridgeOutbox(queueDirectory);

    try {
      assert.equal(
        saved.getCompleted(firstHash)?.outcome.status,
        "SETTLED",
      );

      console.log("PASS: shutdown waits for active delivery and saves its result.");

      assert.equal(saved.getCompleted(secondHash), null);
      assert.equal(saved.getSummary().pending, 1);
      assert.equal(requests, 1);

      console.log("PASS: shutdown leaves the next packet pending.");
    } finally {
      saved.close();
    }

    const release = acquireDeliveryLock(queueDirectory);
    release();

    console.log("PASS: graceful shutdown releases the delivery lock.");

    stage = "idle shutdown";
    const idle = startRunner(
      join(root, "empty-queue"),
      origin,
      credentialFile,
    );
    runners.push(idle);

    await waitFor(() =>
      idle.output().includes('"event":"bridge_started"') ||
      idle.finished(),
    );

    assert.equal(idle.finished(), false);
    assert.equal(idle.child.kill("SIGINT"), true);

    await waitFor(idle.finished);
    const idleExit = await idle.closed;

    assert.equal(idleExit.code, 0);
    assert.equal(idleExit.signal, null);
    assert.equal(requests, 1);

    console.log("PASS: idle runner shuts down cleanly on SIGINT.");

    for (const runner of runners) {
      assert.equal(runner.output().includes(apiKey), false);
      assert.equal(runner.output().includes(firstPacket.ciphertext), false);
      assert.equal(runner.output().includes(secondPacket.ciphertext), false);
    }

    console.log("PASS: runner logs contain no credentials or ciphertext.");
  } catch {
    throw new Error(`Bridge runner check failed during: ${stage}`);
  } finally {
    for (const runner of runners) {
      if (!runner.finished()) {
        runner.child.kill("SIGKILL");
      }
    }

    await Promise.all(runners.map((runner) => runner.closed));

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

    console.log("Temporary runners, gateway, and queues removed.");
  }
}

try {
  await checkBridgeRunner();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Bridge runner check failed.",
  );
  process.exitCode = 1;
}