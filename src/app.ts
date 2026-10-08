import express from "express";
import { pool } from "./db/pool.js";
import { bridgeAuth } from "./middleware/bridge-auth.js";

const app = express();

app.use(express.json({ limit: "16kb" }));

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

app.get("/api/bridge/me", bridgeAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    bridgeId: res.locals.bridge.id,
    name: res.locals.bridge.name,
  });
});

export default app;