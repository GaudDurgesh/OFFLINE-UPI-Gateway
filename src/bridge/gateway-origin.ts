export function validateGatewayOrigin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048
  ) {
    throw new Error("Invalid gateway origin.");
  }

  const url = new URL(value);

  const localHttp =
    url.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);

  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin
  ) {
    throw new Error(
      "Use a canonical HTTPS origin, or a local HTTP development origin.",
    );
  }

  return url.origin;
}