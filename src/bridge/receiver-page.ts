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
      <hr>

<h2>Check payment status</h2>
<p>Enter the receiver token above and the packet hash below.</p>

<form id="status-form">
  <label for="status-hash">Packet hash</label>
  <input
    id="status-hash"
    type="text"
    required
    minlength="64"
    maxlength="64"
    pattern="[0-9a-f]{64}"
    autocomplete="off"
    autocapitalize="none"
    spellcheck="false"
  >

  <button id="check-status" type="submit">
    Check payment status
  </button>
</form>

<p id="status-result" role="status" aria-live="polite"></p>
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
const statusForm = document.getElementById("status-form");
const statusHashInput = document.getElementById("status-hash");
const statusButton = document.getElementById("check-status");
const statusResult = document.getElementById("status-result");

let checkingStatus = false;

statusForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (checkingStatus) return;

  if (location.protocol !== "https:") {
    statusResult.textContent = "Open this page using HTTPS.";
    return;
  }

  const receiverToken = tokenInput.value.trim();
  const hash = statusHashInput.value.trim();

  if (
    receiverToken.length !== 78 ||
    !/^mesh_receiver_[0-9a-f]{64}$/.test(receiverToken)
  ) {
    statusResult.textContent = "Enter a valid receiver token above.";
    return;
  }

  if (hash.length !== 64 || !/^[0-9a-f]{64}$/.test(hash)) {
    statusResult.textContent = "Enter a valid 64-character packet hash.";
    return;
  }

  checkingStatus = true;
  statusButton.disabled = true;
  tokenInput.value = "";
  statusResult.textContent = "Checking payment status...";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch("/packets/" + hash, {
      headers: {
        Authorization: "Bearer " + receiverToken,
      },
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });

    if (response.status === 401) {
      statusResult.textContent = "Receiver token rejected. Enter it again.";
      return;
    }

    if (response.status === 403) {
  statusResult.textContent =
    "Request blocked. Open the receiver page directly and retry.";
  return;
}

    if (response.status === 429) {
      statusResult.textContent = "Too many checks. Wait a minute and retry.";
      return;
    }

    if (response.status !== 200 && response.status !== 404) {
      throw new Error("Result unavailable.");
    }

    const data = await response.json();

    if (!data || data.packetHash !== hash) {
      throw new Error("Unexpected packet result.");
    }

    if (
      response.status === 404 &&
      data.deliveryStatus === "NOT_FOUND"
    ) {
      statusResult.textContent =
        "This bridge has no stored record for this packet. " +
        "This does not prove that the payment failed.";
      return;
    }

    if (response.status !== 200) {
      throw new Error("Unexpected response.");
    }

    switch (data.deliveryStatus) {
      case "PENDING":
        statusResult.textContent =
          "Pending delivery or awaiting confirmation. Payment is not yet confirmed.";
        break;

      case "RETRY_SCHEDULED":
        statusResult.textContent =
          "Waiting for a delivery retry. Payment is not yet confirmed.";
        break;

      case "PAUSED":
        statusResult.textContent =
          "Bridge delivery is paused. The bridge operator must resolve it.";
        break;

      case "COMPLETED": {
        const saved = data.response;

        if (!saved || saved.packetHash !== hash || !saved.outcome) {
          throw new Error("Missing stored outcome.");
        }

        const outcome = saved.outcome;

        if (
          (outcome.status === "SETTLED" ||
            outcome.status === "DUPLICATE") &&
          typeof outcome.transactionId === "string" &&
          /^[1-9][0-9]*$/.test(outcome.transactionId)
        ) {
          statusResult.textContent =
            "Demo payment settled. Transaction ID: " +
            outcome.transactionId +
            ". This is the gateway result stored by this bridge.";
        } else if (
          (outcome.status === "INVALID" ||
            outcome.status === "REJECTED") &&
          typeof outcome.reason === "string"
        ) {
          statusResult.textContent =
            "Payment was not settled. Reason: " + outcome.reason;
        } else {
          throw new Error("Unexpected outcome.");
        }

        break;
      }

      default:
        throw new Error("Unknown delivery status.");
    }
  } catch {
    statusResult.textContent =
      "Could not confirm the stored result. Retry this status check; " +
      "do not create another payment.";
  } finally {
    clearTimeout(timeout);
    checkingStatus = false;
    statusButton.disabled = false;
  }
});
`;