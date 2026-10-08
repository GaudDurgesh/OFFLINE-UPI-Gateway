import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function loadServerKeys() {
  const directory = resolve(process.cwd(), ".keys");

  const [privatePem, publicPem] = await Promise.all([
    readFile(resolve(directory, "server-private.pem"), "utf8"),
    readFile(resolve(directory, "server-public.pem"), "utf8"),
  ]);

  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);

  for (const key of [privateKey, publicKey]) {
    if (
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength !== 2048
    ) {
      throw new Error("Expected RSA-2048 server keys.");
    }
  }

  const derivedPublic = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });

  const savedPublic = publicKey.export({
    type: "spki",
    format: "der",
  });

  if (!derivedPublic.equals(savedPublic)) {
    throw new Error("Server public and private keys do not match.");
  }

  return { privateKey, publicKey };
}