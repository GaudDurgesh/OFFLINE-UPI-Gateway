import { rateLimit } from "express-rate-limit";

// Runs before authentication, protecting the authentication lookup.
export const bridgeIpLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  identifier: "bridge-ip",
  message: {
    error: "RATE_LIMITED",
    message: "Too many requests. Retry later.",
  },
});

// Runs only after bridgeAuth has verified the credential.
export const bridgeIdentityLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  identifier: "bridge-identity",
  keyGenerator: (_req, res) => res.locals.bridge.id,
  message: {
    error: "RATE_LIMITED",
    message: "Bridge request limit reached. Retry later.",
  },
});