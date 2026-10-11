import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function acquireDeliveryLock(
  directory = ".bridge-data",
): () => void {
  if (!directory.trim()) {
    throw new Error("Bridge data directory cannot be empty.");
  }

  const location = resolve(directory);

  mkdirSync(location, {
    recursive: true,
    mode: 0o700,
  });

  const database = new DatabaseSync(
    resolve(location, "delivery-lock.sqlite"),
  );

  try {
    // Fail immediately if another delivery process holds the lock.
    database.exec(`
      PRAGMA busy_timeout = 0;
      BEGIN EXCLUSIVE;
    `);
  } catch {
    database.close();

    throw new Error(
      "Cannot acquire delivery lock. Another delivery process may be running, " +
      "or the lock database is unavailable.",
    );
  }

  let released = false;

  return function releaseDeliveryLock(): void {
    if (released) {
      return;
    }

    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
      released = true;
    }
  };
}