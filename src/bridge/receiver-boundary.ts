import type { RequestHandler } from "express";
import { isIPv4 } from "node:net";

export function createReceiverBoundary(
  expectedOrigin: string,
): RequestHandler {
  const configured = new URL(expectedOrigin);

  if (
    configured.protocol !== "https:" ||
    !isIPv4(configured.hostname) ||
    configured.hostname === "0.0.0.0" ||
    configured.username ||
    configured.password ||
    configured.pathname !== "/" ||
    configured.search ||
    configured.hash ||
    configured.origin !== expectedOrigin
  ) {
    throw new Error("Invalid receiver origin configuration.");
  }

  const expectedHost = configured.host;

  return (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.vary("Origin");

    // Count raw headers so duplicate Host/Origin fields are rejected.
    let hostCount = 0;
    let originCount = 0;

    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index]?.toLowerCase();

      if (name === "host") hostCount += 1;
      if (name === "origin") originCount += 1;
    }

    if (hostCount !== 1 || req.headers.host !== expectedHost) {
      res.status(400).json({ error: "INVALID_RECEIVER_HOST" });
      return;
    }

    const origin = req.headers.origin;

    if (
      originCount > 1 ||
      (origin !== undefined && origin !== expectedOrigin)
    ) {
      res.status(403).json({ error: "INVALID_RECEIVER_ORIGIN" });
      return;
    }

    next();
  };
}