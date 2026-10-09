import { Router, json } from "express";
import { loadServerKeys } from "../crypto/server-keys.js";
import { bridgeAuth } from "../middleware/bridge-auth.js";
import { bridgeIdentityLimiter } from "../middleware/rate-limit.js";
import { ingestPacket } from "../services/ingestion.js";

const router = Router();

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
    const result = await ingestPacket(req.body, privateKey);

    // HTTP 200 means processing returned an outcome.
    // The outcome determines whether the payment settled or was rejected.
    res.status(200).json(result);
  },
);

export default router;