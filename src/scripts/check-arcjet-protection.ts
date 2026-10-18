import assert from "node:assert/strict";
import type { Request } from "express";
import {
  createArcjetCheck,
  type ArcjetProtect,
} from "../services/arcjet-protection.js";

type Decision = Awaited<ReturnType<ArcjetProtect>>;

function decision(
  outcome: "ALLOW" | "DENY" | "ERROR",
): Decision {
  return {
    isAllowed: () => outcome === "ALLOW",
    isDenied: () => outcome === "DENY",
    isErrored: () => outcome === "ERROR",
    results: [],
  };
}

function request(ip = "127.0.0.1"): Request {
  const headers: Record<string, string> = {
    authorization: "Bearer SECRET_BRIDGE_KEY",
    cookie: "session=SECRET_COOKIE",
    "x-forwarded-for": "203.0.113.55",
    host: "untrusted.example",
    "user-agent": "bridge-test",
    "content-type": "application/json",
    accept: "application/json",
  };

  // Minimal Express request fixture for this adapter.
  return {
    method: "POST",
    httpVersion: "1.1",
    originalUrl: "/api/bridge/ingest?secret=SECRET_QUERY",
    secure: false,
    socket: { remoteAddress: ip },
    body: { ciphertext: "SECRET_CIPHERTEXT" },
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

async function checkAdapter() {
  let calls = 0;

  const allow: ArcjetProtect = async () => {
    calls++;
    return decision("ALLOW");
  };

  const disabled = createArcjetCheck("OFF", undefined, allow);
  assert.equal(await disabled(request()), "ALLOW");
  assert.equal(calls, 0);
  console.log("PASS: OFF makes no protection calls.");

  assert.throws(() => createArcjetCheck("LIVE"));
  console.log("PASS: enabled protection requires a key.");

  const inspect: ArcjetProtect = async (metadata, options) => {
    calls++;

    assert.deepEqual(metadata, {
      method: "POST",
      httpVersion: "1.1",
      url: "/api/bridge/ingest",
      headers: {
        "user-agent": "bridge-test",
        "content-type": "application/json",
        accept: "application/json",
        host: "gateway.invalid",
      },
      socket: {
        remoteAddress: "127.0.0.1",
        encrypted: false,
      },
    });

    assert.deepEqual(options, { ipSrc: "127.0.0.1" });
    assert.equal(JSON.stringify(metadata).includes("SECRET"), false);

    return decision("ALLOW");
  };

  const filtered = createArcjetCheck("LIVE", "test-only", inspect);
  assert.equal(await filtered(request()), "ALLOW");
  console.log("PASS: credentials, body, query, and forwarding headers are excluded.");

  const beforeInvalid = calls;
  assert.equal(await filtered(request("not-an-ip")), "ERROR");
  assert.equal(await filtered(request("")), "ERROR");
  assert.equal(calls, beforeInvalid);
  console.log("PASS: invalid connection addresses never reach the SDK.");

  for (const outcome of ["ALLOW", "DENY", "ERROR"] as const) {
    const check = createArcjetCheck(
      "LIVE",
      "test-only",
      async () => decision(outcome),
    );

    assert.equal(await check(request()), outcome);
  }
  console.log("PASS: top-level SDK decisions map correctly.");

  let active = 0;
  let maximumActive = 0;
  let entered = 0;
  let fail = false;
  let release!: () => void;

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const slow: ArcjetProtect = async () => {
    entered++;
    active++;
    maximumActive = Math.max(maximumActive, active);

    try {
      await held;
      if (fail) throw new Error("Simulated SDK failure");
      return decision("ALLOW");
    } finally {
      active--;
    }
  };

  const bounded = createArcjetCheck("LIVE", "test-only", slow);

  const pending = Array.from({ length: 4 }, () => bounded(request()));

  try {
    assert.equal(active, 4);
    assert.equal(await bounded(request()), "ERROR");
    assert.equal(entered, 4);
    assert.equal(maximumActive, 4);
  } finally {
    release();
    await Promise.all(pending);
  }

  assert.equal(active, 0);
  assert.equal(await bounded(request()), "ALLOW");
  console.log("PASS: four active checks block the fifth and release capacity.");

  fail = true;
  await assert.rejects(() => bounded(request()), /Simulated SDK failure/);

  fail = false;
  assert.equal(await bounded(request()), "ALLOW");
  assert.equal(active, 0);
  console.log("PASS: SDK exceptions release capacity for later checks.");
}

try {
  await checkAdapter();
} catch (error) {
  console.error("Arcjet adapter check failed:", error);
  process.exitCode = 1;
}