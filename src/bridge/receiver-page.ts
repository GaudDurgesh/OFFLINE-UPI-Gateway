export const receiverPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local payment bridge</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #f3f6fa;
      color: #162536;
      font: 16px/1.5 system-ui, sans-serif;
    }
    main {
      max-width: 480px;
      margin: 24px auto;
      padding: 24px;
      border-radius: 16px;
      background: white;
    }
    h1 { font-size: 25px; margin-top: 0; }
    label { display: block; margin-top: 20px; font-weight: 600; }
    input, button {
      box-sizing: border-box;
      width: 100%;
      margin-top: 8px;
      padding: 12px;
      font: inherit;
    }
    input { border: 1px solid #a9b8c9; border-radius: 8px; }
    button {
      border: 0;
      border-radius: 8px;
      background: #1456b8;
      color: white;
      cursor: pointer;
    }
    button:disabled { opacity: .6; cursor: wait; }
    #result { white-space: pre-wrap; overflow-wrap: anywhere; }
    .note { color: #526175; font-size: 14px; }
  </style>
  <script src="/receiver.js" defer></script>
</head>
<body>
  <main>
    <h1>Send to local bridge</h1>
    <p>Upload an existing encrypted payment packet.</p>
    <p class="note">Queued means stored on this laptop.
      It does not mean the payment has settled.</p>

    <form id="send-form">
      <label for="token">Receiver token</label>
      <input id="token" type="password" required
        autocomplete="off" spellcheck="false"
        autocapitalize="none" maxlength="78">

      <label for="packet">Packet JSON file</label>
      <input id="packet" type="file"
        accept=".json,application/json" required>

      <button id="send" type="submit">Queue packet</button>
    </form>

    <p id="result" role="status" aria-live="polite"></p>
    <p class="note">Maximum file size: 16 KiB.
      Use the receiver token, not the gateway API key.</p>
  </main>
</body>
</html>`;

export const receiverScript = `
"use strict";

const form = document.getElementById("send-form");
const tokenInput = document.getElementById("token");
const packetInput = document.getElementById("packet");
const button = document.getElementById("send");
const result = document.getElementById("result");

let sending = false;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sending) return;

  if (location.protocol !== "https:") {
    result.textContent = "Open this page using HTTPS.";
    return;
  }

  const token = tokenInput.value;
  if (
    token.length !== 78 ||
    !/^mesh_receiver_[0-9a-f]{64}$/.test(token)
  ) {
    result.textContent = "Enter a valid receiver token.";
    return;
  }

  const file = packetInput.files[0];
  if (!file || file.size === 0 || file.size > 16384) {
    result.textContent = "Choose a non-empty JSON file of at most 16 KiB.";
    return;
  }

  let body;
  let packetHash;

  try {
    body = new TextDecoder("utf-8", { fatal: true })
      .decode(await file.arrayBuffer());

    const packet = JSON.parse(body);
    if (
      !packet ||
      typeof packet !== "object" ||
      typeof packet.ciphertext !== "string"
    ) {
      throw new Error("Invalid packet");
    }

    const bytes = Uint8Array.from(
      atob(packet.ciphertext),
      (character) => character.charCodeAt(0),
    );

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    packetHash = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    result.textContent = "The file is not a readable packet JSON file.";
    return;
  }

  sending = true;
  button.disabled = true;
  tokenInput.value = "";
  result.textContent = "Sending packet…";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("/packets", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });

    const data = await response.json();

    const accepted =
      (response.status === 202 && data.status === "QUEUED") ||
      (response.status === 200 && data.status === "ALREADY_KNOWN");

    if (accepted && data.packetHash === packetHash) {
      result.textContent =
        (data.status === "QUEUED"
          ? "Packet queued."
          : "Packet already stored.") +
        "\\nPayment settlement is not confirmed here." +
        "\\nPacket hash: " + packetHash;
      return;
    }

    const messages = {
      400: "The packet was rejected as invalid.",
      401: "Receiver token rejected. Check the token and try again.",
      413: "The packet exceeds the size limit.",
      415: "The packet format or encoding is unsupported.",
      429: "Too many requests. Wait before trying again.",
      503: "The bridge is busy or full. Keep the file and retry later.",
    };

    result.textContent = messages[response.status] ||
      "Delivery could not be confirmed. Retry the same packet file.";
  } catch {
    result.textContent =
      "Delivery could not be confirmed. Keep and retry the same packet file.";
  } finally {
    clearTimeout(timer);
    sending = false;
    button.disabled = false;
  }
});
`;