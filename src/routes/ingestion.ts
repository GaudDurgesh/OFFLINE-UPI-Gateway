import { Router, json } from "express";
import { loadServerKeys } from "../crypto/server-keys.js";
import { bridgeAuth } from "../middleware/bridge-auth.js";
import { bridgeIdentityLimiter } from "../middleware/rate-limit.js";
import { createConcurrencyGate } from "../services/concurrency-gate.js";
import { ingestPacket } from "../services/ingestion.js";

const router = Router();

const ingestionGate = createConcurrencyGate(4);
// Load and validate once at startup.
// Missing or mismatched keys prevent the server from starting.
const { privateKey } = await loadServerKeys();

router.post(
  "/ingest",
  bridgeAuth,
  bridgeIdentityLimiter,
  (req, res, next) => {
    if (!req.is("application/json")) {
      res.status(415).json({ error: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }

    next();
  },
  json({
    limit: "16kb",
    strict: true,
    inflate: false,
  }),
  async (req, res) => {
  const attempt = await ingestionGate.run(() =>
    ingestPacket(req.body, privateKey),
  );

  if (!attempt.accepted) {
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "SERVICE_BUSY" });
    return;
  }

  res.status(200).json(attempt.value);
},
);

export default router;