import {
  constants,
  createCipheriv,
  createDecipheriv,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

const WRAPPED_KEY_BYTES = 256;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const OVERHEAD = WRAPPED_KEY_BYTES + IV_BYTES + TAG_BYTES;

const MAX_PLAINTEXT_BYTES = 4096;
const MAX_PACKET_BYTES = OVERHEAD + MAX_PLAINTEXT_BYTES;
const MAX_BASE64_LENGTH = Math.ceil(MAX_PACKET_BYTES / 3) * 4;

const CONTEXT = Buffer.from("offline-upi-gateway:envelope:v1", "utf8");

type DecryptResult =
  | { ok: true; plaintext: Buffer }
  | { ok: false; reason: "INVALID_CIPHERTEXT" };

export function encryptPacket(
  plaintext: Buffer,
  publicKey: KeyObject,
): string {
  if (
    plaintext.length === 0 ||
    plaintext.length > MAX_PLAINTEXT_BYTES
  ) {
    throw new Error("Plaintext must contain between 1 and 4096 bytes.");
  }

  if (
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "rsa" ||
    publicKey.asymmetricKeyDetails?.modulusLength !== 2048
  ) {
    throw new Error("Expected an RSA-2048 public key.");
  }

  const aesKey = randomBytes(32);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv("aes-256-gcm", aesKey, iv, {
    authTagLength: TAG_BYTES,
  });

  cipher.setAAD(CONTEXT);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);

  const wrappedKey = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  );

  return Buffer.concat([
    wrappedKey,
    iv,
    ciphertext,
    cipher.getAuthTag(),
  ]).toString("base64");
}

export function decryptPacket(
  encoded: string,
  privateKey: KeyObject,
): DecryptResult {
  const invalid = {
    ok: false,
    reason: "INVALID_CIPHERTEXT",
  } as const;

  try {
    if (
      typeof encoded !== "string" ||
      encoded.length > MAX_BASE64_LENGTH
    ) {
      return invalid;
    }

    const packet = Buffer.from(encoded, "base64");

    if (
      packet.length <= OVERHEAD ||
      packet.length > MAX_PACKET_BYTES ||
      packet.toString("base64") !== encoded
    ) {
      return invalid;
    }

    const wrappedKey = packet.subarray(0, WRAPPED_KEY_BYTES);
    const iv = packet.subarray(
      WRAPPED_KEY_BYTES,
      WRAPPED_KEY_BYTES + IV_BYTES,
    );
    const ciphertext = packet.subarray(
      WRAPPED_KEY_BYTES + IV_BYTES,
      packet.length - TAG_BYTES,
    );
    const tag = packet.subarray(packet.length - TAG_BYTES);

    const aesKey = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      wrappedKey,
    );

    if (aesKey.length !== 32) {
      return invalid;
    }

    const decipher = createDecipheriv("aes-256-gcm", aesKey, iv, {
      authTagLength: TAG_BYTES,
    });

    decipher.setAAD(CONTEXT);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return { ok: true, plaintext };
  } catch {
    return invalid;
  }
}