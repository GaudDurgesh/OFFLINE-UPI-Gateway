import type { RequestHandler } from "express";
import { pool } from "../db/pool.js";
import { hashBridgeKey, isBridgeKey } from "../crypto/bridge-keys.js";

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
    const result = await pool.query<BridgeRow>(
      `SELECT id, name, status
       FROM bridge_nodes
       WHERE api_key_hash = $1`,
      [hashBridgeKey(apiKey)],
    );

    bridge = result.rows[0];
  } catch {
    console.error("Bridge authentication database query failed.");
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