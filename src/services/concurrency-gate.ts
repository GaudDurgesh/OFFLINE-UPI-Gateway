export function createConcurrencyGate(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Concurrency limit must be a positive integer.");
  }

  let active = 0;

  return {
    async run<T>(
      work: () => Promise<T>,
    ): Promise<
      | { accepted: false }
      | { accepted: true; value: T }
    > {
      if (active >= limit) {
        return { accepted: false };
      }

      active += 1;

      try {
        return {
          accepted: true,
          value: await work(),
        };
      } finally {
        active -= 1;
      }
    },
  };
}