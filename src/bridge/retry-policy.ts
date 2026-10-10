const BASE_DELAY_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

function parseRetryAfter(
  value: string | null,
  nowMs: number,
): number {
  if (value === null || value.length > 128) {
    return 0;
  }

  const trimmed = value.trim();

  if (/^[0-9]+$/.test(trimmed)) {
    const delayMs = Number(trimmed) * 1_000;

    return (
      Number.isSafeInteger(delayMs) &&
      Number.isSafeInteger(nowMs + delayMs)
    ) ? delayMs : 0;
  }

  // Accept the standard HTTP-date format, not arbitrary date strings.
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)
  ) {
    return 0;
  }

  const timestamp = Date.parse(trimmed);

  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  return Math.max(0, timestamp - nowMs);
}

export function retryDelayMs(
  attempt: number,
  retryAfter: string | null = null,
  nowMs = Date.now(),
  random = Math.random(),
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Attempt must be a positive safe integer.");
  }

  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid retry clock.");
  }

  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new Error("Random value must be between 0 inclusive and 1 exclusive.");
  }

  const backoff = Math.min(
    MAX_BACKOFF_MS,
    BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 6),
  );

  // Wait between half and all of the current backoff.
  const jittered = Math.floor(backoff * (0.5 + random * 0.5));

  const delayMs = Math.max(
    jittered,
    parseRetryAfter(retryAfter, nowMs),
  );

  if (!Number.isSafeInteger(nowMs + delayMs)) {
    throw new Error("Retry timestamp exceeds the supported range.");
  }

  return delayMs;
}