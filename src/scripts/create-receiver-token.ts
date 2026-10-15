import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error("This command takes no arguments.");
  }

  const directory = resolve(".keys");
  const filename = resolve(directory, "receiver.json");

  await mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });

  const token = `mesh_receiver_${randomBytes(32).toString("hex")}`;

  await writeFile(
    filename,
    JSON.stringify({ token }, null, 2) + "\n",
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );

  console.log("Receiver credential created: .keys/receiver.json");
  console.log("Keep this file private. Existing credentials are never overwritten.");
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof Error && "code" in error
      ? error.code
      : undefined;

  if (code === "EEXIST") {
    console.error("Receiver credential already exists. It was not changed.");
  } else {
    console.error("Receiver credential creation failed. Check arguments and directory access.");
  }

  process.exitCode = 1;
}