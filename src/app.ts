import express from "express";
import { pool } from "./db/pool.js";
import { bridgeAuth } from "./middleware/bridge-auth.js";
import helmet from "helmet";
import {
  bridgeIpLimiter,
  bridgeIdentityLimiter,
} from "./middleware/rate-limit.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());

app.use("/api/bridge", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use("/api/bridge", bridgeIpLimiter);

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.status(200).json({
      status: "ok",
      service: "offline-upi-system",
      database: "connected",
    });
  } catch {
    console.error("Database health check failed.");

    res.status(503).json({
      status: "error",
      service: "offline-upi-system",
      database: "unavailable",
    });
  }
});

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

export default app;