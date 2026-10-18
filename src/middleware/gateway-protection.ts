import type { Request, RequestHandler } from "express";

export type ProtectionMode = "OFF" | "DRY_RUN" | "LIVE";
export type ProtectionResult = "ALLOW" | "DENY" | "ERROR";

type ProtectionCheck = (
  request: Request,
) => Promise<ProtectionResult>;

export function createGatewayProtection(
  mode: ProtectionMode,
  check: ProtectionCheck,
): RequestHandler {
  return async (req, res, next) => {
    if (mode === "OFF") {
      next();
      return;
    }

    let result: ProtectionResult;

    try {
      result = await check(req);
    } catch {
      result = "ERROR";
    }

    // Unexpected adapter output must not silently allow a request.
    if (
      result !== "ALLOW" &&
      result !== "DENY" &&
      result !== "ERROR"
    ) {
      result = "ERROR";
    }

    if (result !== "ALLOW") {
      console.warn(JSON.stringify({
        event: "gateway_protection_decision",
        requestId: res.locals.requestId ?? null,
        mode,
        result,
      }));
    }

    if (mode === "DRY_RUN" || result === "ALLOW") {
      next();
      return;
    }

    if (result === "DENY") {
      res.status(403).json({
        error: "REQUEST_BLOCKED",
      });
      return;
    }

    res.setHeader("Retry-After", "2");
    res.status(503).json({
      error: "PROTECTION_UNAVAILABLE",
    });
  };
}