import { isBridgeKey } from "../crypto/bridge-keys.js";
import { validatePacket } from "../domain/packet.js";
import {
  validateGatewayResponse,
  type GatewayResponse,
} from "./gateway-response.js";

export type DeliveryAttempt =
  | {
      status: "COMPLETED";
      response: GatewayResponse;
    }
  | {
      status: "RETRY";
      reason:
        | "NETWORK_OR_TIMEOUT"
        | "TEMPORARY_HTTP_FAILURE"
        | "INVALID_GATEWAY_RESPONSE";
      retryAfter: string | null;
    }
  | {
      status: "PAUSED";
      reason: "AUTHENTICATION_FAILED" | "UNEXPECTED_HTTP_STATUS";
      httpStatus: number;
    };

const MAX_RESPONSE_BYTES = 16 * 1024;

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();

  if (contentType !== "application/json" || !response.body) {
    await response.body?.cancel();
    throw new Error("Expected a JSON response.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > MAX_RESPONSE_BYTES) {
        throw new Error("Gateway response exceeds size limit.");
      }

      chunks.push(value);
    }

    const text = new TextDecoder("utf-8", {
      fatal: true,
    }).decode(Buffer.concat(chunks));

    return JSON.parse(text);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function createGatewayClient(options: {
  gatewayOrigin: string;
  apiKey: string;
  timeoutMs?: number;
}) {
  const origin = new URL(options.gatewayOrigin);
  const timeoutMs = options.timeoutMs ?? 15_000;

  const localHttp =
    origin.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname);

  if (
    (origin.protocol !== "https:" && !localHttp) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      "Use an HTTPS gateway origin, or local HTTP for development.",
    );
  }

  if (!isBridgeKey(options.apiKey)) {
    throw new Error("Invalid bridge credential format.");
  }

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Request timeout must be between 1 and 60000 ms.");
  }

  const endpoint = new URL("/api/bridge/ingest", origin);
  const apiKey = options.apiKey;

  return async function deliver(input: unknown): Promise<DeliveryAttempt> {
    const validated = validatePacket(input);

    if (!validated.ok) {
      throw new Error("Cannot deliver an invalid local packet.");
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(validated.packet),
      });

      if (response.status !== 200) {
        const header = response.headers.get("retry-after");
        const retryAfter =
          header !== null && header.length <= 128 ? header : null;

        // Release the connection without reading an arbitrary error body.
        await response.body?.cancel();

        if (response.status === 401 || response.status === 403) {
          return {
            status: "PAUSED",
            reason: "AUTHENTICATION_FAILED",
            httpStatus: response.status,
          };
        }

        if (
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          return {
            status: "RETRY",
            reason: "TEMPORARY_HTTP_FAILURE",
            retryAfter,
          };
        }

        return {
          status: "PAUSED",
          reason: "UNEXPECTED_HTTP_STATUS",
          httpStatus: response.status,
        };
      }

      let body: unknown;

      try {
        body = await readBoundedJson(response);
      } catch {
        return {
          status: "RETRY",
          reason: "INVALID_GATEWAY_RESPONSE",
          retryAfter: null,
        };
      }

      const checked = validateGatewayResponse(
        body,
        validated.packetHash,
      );

      if (!checked.ok) {
        return {
          status: "RETRY",
          reason: "INVALID_GATEWAY_RESPONSE",
          retryAfter: null,
        };
      }

      return {
        status: "COMPLETED",
        response: checked.response,
      };
    } catch {
      return {
        status: "RETRY",
        reason: "NETWORK_OR_TIMEOUT",
        retryAfter: null,
      };
    }
  };
}