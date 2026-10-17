import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeOutbox } from "../bridge/outbox.js";
import { readApiKey } from "../bridge/credentials.js";

async function checkBinding() {
  const root = await mkdtemp(join(tmpdir(), "bridge-binding-"));
  const apiKey = `mesh_bridge_${randomBytes(32).toString("hex")}`;
  const credentialFile = join(root, "credentials.json");
  const queueDirectory = join(root, "queue");

  const packet = {
    packetId: randomUUID(),
    ttl: 5,
    createdAt: Date.now(),
    ciphertext: randomBytes(300).toString("base64"),
  };

  const outbox = new BridgeOutbox(queueDirectory);
  let packetHash: string;

  try {
    packetHash = outbox.enqueue(packet).packetHash;
  } finally {
    outbox.close();
  }

  let requests = 0;

  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert(address && typeof address !== "string");

    const origin = `http://127.0.0.1:${address.port}`;

    async function saveCredential(value: unknown) {
      await writeFile(
        credentialFile,
        JSON.stringify(value),
        { mode: 0o600 },
      );
    }

    async function runCommand(script: string) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("src/scripts", script),
          origin,
          credentialFile,
        ],
        {
          env: {
            ...process.env,
            BRIDGE_DATA_DIR: queueDirectory,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let output = "";
      let timedOut = false;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        output += text;
      });
      child.stderr.on("data", (text: string) => {
        output += text;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 15_000);

      try {
        const [code, signal] = await once(child, "close");

        assert.equal(timedOut, false, "Delivery command did not exit.");
        assert.equal(signal, null);
        assert.equal(code, 1);
        assert.equal(output.includes(apiKey), false);
        assert.equal(output.includes(packet.ciphertext), false);
      } finally {
        clearTimeout(timer);
      }
    }

    await saveCredential({ apiKey, gatewayOrigin: origin });
    assert.equal(await readApiKey(credentialFile, origin), apiKey);
    console.log("PASS: a matching gateway binding permits credential loading.");

    const cases = [
      {
        name: "missing gateway binding",
        credential: { apiKey },
      },
      {
        name: "different gateway port",
        credential: {
          apiKey,
          gatewayOrigin:
            `http://127.0.0.1:${address.port === 18001 ? 18002 : 18001}`,
        },
      },
      {
        name: "different gateway hostname",
        credential: {
          apiKey,
          gatewayOrigin: `http://localhost:${address.port}`,
        },
      },
      {
        name: "different gateway scheme",
        credential: {
          apiKey,
          gatewayOrigin: `https://127.0.0.1:${address.port}`,
        },
      },
      {
        name: "malformed gateway binding",
        credential: {
          apiKey,
          gatewayOrigin: origin + "/unexpected-path",
        },
      },
    ];

    for (const testCase of cases) {
      await saveCredential(testCase.credential);

      await assert.rejects(() =>
        readApiKey(credentialFile, origin),
      );

      await runCommand("bridge-deliver-once.ts");
      await runCommand("bridge-run.ts");

      assert.equal(requests, 0);

      console.log(
        `PASS: ${testCase.name} blocks both commands before sending.`,
      );
    }

    const inspection = new BridgeOutbox(queueDirectory);

    try {
      const status = inspection.getPacketStatus(packetHash);

      assert.equal(status.deliveryStatus, "PENDING");
      assert.equal(status.response, null);
      assert.equal(status.retry, null);
      assert.equal(status.pause, null);
      assert.equal(inspection.getSummary().total, 1);
    } finally {
      inspection.close();
    }

    console.log("PASS: rejected destinations leave pending work unchanged.");
  } finally {
    try {
      await new Promise<void>((resolveDone, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolveDone();
        });
        server.closeAllConnections();
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      console.log("Temporary binding credentials, server and queue removed.");
    }
  }
}

try {
  await checkBinding();
} catch {
  // Avoid printing assertion details that could contain credentials.
  console.error("Credential binding check failed.");
  process.exitCode = 1;
}