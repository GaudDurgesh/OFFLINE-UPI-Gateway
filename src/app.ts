import express from "express";
import { pool } from "./db/pool.js";

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

export default app;