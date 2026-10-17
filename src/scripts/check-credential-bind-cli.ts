import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readApiKey } from "../bridge/credentials.js";

async function checkBindCli() {
  const directory = await mkdtemp(join(tmpdir(), "credential-bind-"));
  const source = join(directory, "original.json");
  const destination = join(directory, "bound.json");
  const apiKey = `mesh_bridge_${randomBytes(32).toString("hex")}`;
  const origin = "http://127.0.0.1:18000";
  const original = JSON.stringify({
    bridgeId: "test-bridge",
    name: "Temporary test bridge",
    apiKey,
  });

  async function run(args: string[]) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/scripts/bind-bridge-credential.ts"),
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
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
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveDone, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          resolveDone({ code, signal });
        });
      });

      assert.equal(timedOut, false);
      assert.equal(result.signal, null);
      assert.equal(output.includes(apiKey), false);

      return result.code;
    } finally {
      clearTimeout(timer);
    }
  }

  async function assertMissing(filename: string) {
    await assert.rejects(access(filename), { code: "ENOENT" });
  }

  try {
    await writeFile(source, original, { flag: "wx", mode: 0o600 });

    assert.equal(await run([source, origin, destination]), 0);
    assert.equal(await readFile(source, "utf8"), original);

    const boundText = await readFile(destination, "utf8");
    const bound = JSON.parse(boundText);

    assert.deepEqual(bound, {
      ...JSON.parse(original),
      gatewayOrigin: origin,
    });

    assert.equal(await readApiKey(destination, origin), apiKey);
    console.log("PASS: binding preserves the key, metadata and original file.");

    assert.equal(await run([source, origin, destination]), 1);
    assert.equal(await readFile(destination, "utf8"), boundText);
    console.log("PASS: an existing destination cannot be overwritten.");

    assert.equal(await run([source, origin, source]), 1);
    assert.equal(await readFile(source, "utf8"), original);
    console.log("PASS: source and destination cannot be the same file.");

    const rebound = join(directory, "rebound.json");
    assert.equal(
      await run([destination, "http://127.0.0.1:18001", rebound]),
      1,
    );
    await assertMissing(rebound);
    assert.equal(await readFile(destination, "utf8"), boundText);
    console.log("PASS: an existing binding cannot be changed.");

    const invalidDestination = join(directory, "invalid-origin.json");
    assert.equal(
      await run([source, "http://untrusted.example", invalidDestination]),
      1,
    );
    await assertMissing(invalidDestination);

    assert.equal(await run([]), 1);
    console.log("PASS: invalid origins and missing arguments are rejected.");

    const malformed = join(directory, "malformed.json");
    const malformedOutput = join(directory, "malformed-output.json");
    await writeFile(malformed, '{"apiKey":"invalid"}');

    assert.equal(
      await run([malformed, origin, malformedOutput]),
      1,
    );
    await assertMissing(malformedOutput);
    console.log("PASS: malformed credentials create no bound file.");

    const sameOriginCopy = join(directory, "same-origin-copy.json");
    assert.equal(
      await run([destination, origin, sameOriginCopy]),
      0,
    );
    assert.equal(await readApiKey(sameOriginCopy, origin), apiKey);
    console.log("PASS: copying an existing binding to the same origin is safe.");
  } finally {
    await rm(directory, { recursive: true, force: true });
    console.log("Temporary binding files removed.");
  }
}

try {
  await checkBindCli();
} catch {
  console.error("Credential binding CLI check failed.");
  process.exitCode = 1;
}