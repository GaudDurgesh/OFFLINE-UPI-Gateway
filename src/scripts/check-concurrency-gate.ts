import assert from "node:assert/strict";
import { createConcurrencyGate } from "../services/concurrency-gate.js";

async function checkGate() {
  const gate = createConcurrencyGate(4);

  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  let started = 0;
  const pending = Array.from({ length: 4 }, () =>
    gate.run(async () => {
      started += 1;
      await barrier;
      return "finished";
    }),
  );

  try {
    assert.equal(started, 4);

    let extraWorkRan = false;
    const blocked = await gate.run(async () => {
      extraWorkRan = true;
    });

    assert.deepEqual(blocked, { accepted: false });
    assert.equal(extraWorkRan, false);

    console.log("PASS: four active operations block the fifth.");
    console.log("PASS: blocked work never executes.");
  } finally {
    release();
    await Promise.allSettled(pending);
  }

  const completed = await Promise.all(pending);
  for (const result of completed) {
    assert.deepEqual(result, {
      accepted: true,
      value: "finished",
    });
  }

  assert.deepEqual(
    await gate.run(async () => "retry"),
    { accepted: true, value: "retry" },
  );

  console.log("PASS: capacity returns after operations finish.");

  const failure = new Error("Deliberate test failure");

  const failures = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      gate.run(async () => {
        throw failure;
      }),
    ),
  );

  for (const result of failures) {
    assert.equal(result.status, "rejected");

    if (result.status === "rejected") {
      assert.equal(result.reason, failure);
    }
  }

  const recovered = await Promise.all(
    Array.from({ length: 4 }, () =>
      gate.run(async () => "recovered"),
    ),
  );

  for (const result of recovered) {
    assert.deepEqual(result, {
      accepted: true,
      value: "recovered",
    });
  }

  console.log("PASS: errors propagate and all four slots recover.");
}

try {
  await checkGate();
} catch (error) {
  console.error("Concurrency gate check failed:", error);
  process.exitCode = 1;
}