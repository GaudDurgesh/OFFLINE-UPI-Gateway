import type { ErrorRequestHandler } from "express";

const retryableCodes = new Set([
  "40001", // Serialization failure
  "40P01", // Deadlock
  "55P03", // Lock unavailable / lock timeout
  "57014", // Query cancelled, including statement timeout
  "53300", // Too many database connections
  "57P01", // Database shutting down
  "57P02", // Database crash shutdown
  "57P03", // Database cannot accept connections yet
  "08001", // Unable to establish database connection
  "08003", // Connection does not exist
  "08006", // Connection failure
  "08007", // Transaction outcome unknown
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
]);

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const type =
    typeof error === "object" &&
      error !== null &&
      "type" in error &&
      typeof error.type === "string"
      ? error.type
      : undefined;

  if (type === "entity.too.large") {
    res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
    return;
  }

  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "INVALID_JSON" });
    return;
  }

  if (
    type === "encoding.unsupported" ||
    type === "charset.unsupported"
  ) {
    res.status(415).json({ error: "UNSUPPORTED_ENCODING" });
    return;
  }

  if (
    type === "request.aborted" ||
    type === "request.size.invalid"
  ) {
    res.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }

  // Do not log request bodies, credentials, or raw database errors.

  const code =
    typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
      ? error.code
      : undefined;

  if (code !== undefined && retryableCodes.has(code)) {
    // Log only the recognized code, never the raw error.
    console.warn(JSON.stringify({
      event: "temporary_request_failure",
      requestId: res.locals.requestId ?? null,
      code,
    }));

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "2");
    res.status(503).json({ error: "SERVICE_UNAVAILABLE" });
    return;
  }
  console.error(JSON.stringify({
    event: "unhandled_request_error",
    requestId: res.locals.requestId ?? null,
  }));
  res.status(500).json({ error: "INTERNAL_ERROR" });
};