import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isBridgeKey } from "../crypto/bridge-keys.js";
import { validateGatewayOrigin } from "../bridge/gateway-origin.js";

async function bindCredential(): Promise<void> {
  const args = process.argv.slice(2);

  if (
    args.length !== 3 ||
    !args[0]?.trim() ||
    !args[1]?.trim() ||
    !args[2]?.trim()
  ) {
    throw new Error("Expected source, gateway origin and destination.");
  }

  const source = resolve(args[0]);
  const gatewayOrigin = validateGatewayOrigin(args[1]);
  const destination = resolve(args[2]);

  if (source === destination) {
    throw new Error("Source and destination must be different.");
  }

  const file = await open(source, "r");
  let credentials: Record<string, unknown>;

  try {
    const info = await file.stat();
    const limit = 4096;

    if (!info.isFile() || info.size === 0 || info.size > limit) {
      throw new Error("Invalid credential file.");
    }

    const buffer = Buffer.alloc(limit + 1);
    let total = 0;

    while (total < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        total,
        buffer.length - total,
        null,
      );

      if (bytesRead === 0) break;
      total += bytesRead;
    }

    if (total === 0 || total > limit) {
      throw new Error("Invalid credential size.");
    }

    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(buffer.subarray(0, total)),
    );

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("apiKey" in parsed) ||
      !isBridgeKey(parsed.apiKey)
    ) {
      throw new Error("Invalid bridge credential.");
    }

    if (
      "gatewayOrigin" in parsed &&
      validateGatewayOrigin(parsed.gatewayOrigin) !== gatewayOrigin
    ) {
      throw new Error("Existing gateway binding cannot be changed here.");
    }

    credentials = { ...parsed, gatewayOrigin };
  } finally {
    await file.close();
  }

  const output = JSON.stringify(credentials, null, 2) + "\n";

  if (Buffer.byteLength(output, "utf8") > 4096) {
    throw new Error("Bound credential exceeds the reader's size limit.");
  }

  await writeFile(destination, output, {
    flag: "wx",
    mode: 0o600,
  });

  console.log("Bound credential created. Original file unchanged.");
  console.log("No network request was made.");
}

try {
  await bindCredential();
} catch {
  console.error(
    "Credential binding failed. Usage: npm run bridge:bind -- " +
    "<source-file> <approved-gateway-origin> <new-file>. " +
    "Check the source, origin and destination directory. " +
    "The destination must not already exist. " +
    "If a destination file was created during a failed write, do not use it.",
  );
  process.exitCode = 1;
}