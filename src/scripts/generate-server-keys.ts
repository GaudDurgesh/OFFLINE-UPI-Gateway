import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function generateServerKeys() {
  const directory = resolve(process.cwd(), ".keys");

  // Refuse to overwrite an existing key directory.
  await mkdir(directory, { mode: 0o700 });

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  await writeFile(
    resolve(directory, "server-private.pem"),
    privateKey,
    { flag: "wx", mode: 0o600 },
  );

  await writeFile(
    resolve(directory, "server-public.pem"),
    publicKey,
    { flag: "wx", mode: 0o644 },
  );

  console.log("Server RSA key pair generated.");
  console.log("Private key: .keys/server-private.pem");
  console.log("Public key: .keys/server-public.pem");
}

try {
  await generateServerKeys();
} catch (error) {
  console.error(
    "Key generation failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
}