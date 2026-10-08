import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

function requireP256(key: KeyObject): void {
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("Expected an ECDSA P-256 key.");
  }
}

export function generateDeviceKeyPair() {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });
}

export function signMessage(
  message: Buffer,
  privateKeyPem: string,
): string {
  const key = createPrivateKey(privateKeyPem);
  requireP256(key);

  const signature = sign("sha256", message, {
    key,
    dsaEncoding: "ieee-p1363",
  });

  return signature.toString("base64");
}

export function verifyMessage(
  message: Buffer,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    // A P-256 signature in this format is 64 bytes.
    if (signatureBase64.length !== 88) {
      return false;
    }

    const signature = Buffer.from(signatureBase64, "base64");

    if (
      signature.length !== 64 ||
      signature.toString("base64") !== signatureBase64
    ) {
      return false;
    }

    const key = createPublicKey(publicKeyPem);
    requireP256(key);

    return verify(
      "sha256",
      message,
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}