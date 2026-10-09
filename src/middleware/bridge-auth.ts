import type { RequestHandler } from "express";
import { pool } from "../db/pool.js";
import { hashBridgeKey, isBridgeKey } from "../crypto/bridge-keys.js";
import { createConcurrencyGate } from "../services/concurrency-gate.js";

const authenticationGate = createConcurrencyGate(4);
type BridgeRow = {
  id: string;
  name: string;
  status: "active" | "revoked";
};

export const bridgeAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  const apiKey = match?.[1];

  if (!isBridgeKey(apiKey)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  let bridge: BridgeRow | undefined;

  try {
    const attempt = await authenticationGate.run(() =>
      pool.query<BridgeRow>(
        `SELECT id, name, status
     FROM bridge_nodes
     WHERE api_key_hash = $1`,
        [hashBridgeKey(apiKey)],
      ),
    );

    if (!attempt.accepted) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ error: "SERVICE_BUSY" });
      return;
    }

    bridge = attempt.value.rows[0];
  } catch {
    console.error(JSON.stringify({
      event: "bridge_authentication_database_failure",
      requestId: res.locals.requestId ?? null,
    }));

    res.setHeader("Retry-After", "2");
    res.status(503).json({ error: "SERVICE_UNAVAILABLE" });
    return;
  }

  if (!bridge || bridge.status !== "active") {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  res.locals.bridge = {
    id: bridge.id,
    name: bridge.name,
  };

  next();
};