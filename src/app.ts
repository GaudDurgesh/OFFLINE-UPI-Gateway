import express from "express";
import { pool } from "./db/pool.js";
import { bridgeAuth } from "./middleware/bridge-auth.js";
import helmet from "helmet";
import {
  bridgeIpLimiter,
  bridgeIdentityLimiter,
} from "./middleware/rate-limit.js";
import ingestionRouter from "./routes/ingestion.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestId } from "./middleware/request-id.js";
import type { RequestHandler } from "express";

const app = express();

app.use(requestId);
app.disable("x-powered-by");
app.use(helmet());

app.use("/api/bridge", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use("/api/bridge", bridgeIpLimiter);

app.get("/live", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    status: "ok",
    service: "offline-upi-system",
  });
});

const readiness: RequestHandler = async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    await pool.query("SELECT 1");

    res.status(200).json({
      status: "ok",
      service: "offline-upi-system",
      database: "connected",
    });
  } catch {
    console.warn(JSON.stringify({
      event: "readiness_check_failed",
      requestId: res.locals.requestId ?? null,
    }));

    res.setHeader("Retry-After", "2");
    res.status(503).json({
      status: "error",
      service: "offline-upi-system",
      database: "unavailable",
    });
  }
};

app.get("/ready", readiness);
app.get("/health", readiness);

app.get(
  "/api/bridge/me",
  bridgeAuth,
  bridgeIdentityLimiter,
  (_req, res) => {
    res.status(200).json({
      bridgeId: res.locals.bridge.id,
      name: res.locals.bridge.name,
    });
  },
);

app.use("/api/bridge", ingestionRouter);

app.use(errorHandler);

export default app;