import type { ErrorRequestHandler } from "express";

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
  console.error("Unhandled HTTP request error.");
  res.status(500).json({ error: "INTERNAL_ERROR" });
};