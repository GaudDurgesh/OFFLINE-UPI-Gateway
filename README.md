# Offline UPI Gateway — Payment Relay Prototype

A development prototype for storing signed, encrypted payment instructions
and delivering them to a gateway when connectivity is available.

**This project uses simulated account balances. It does not connect to
banks or process real UPI payments.**

## How it works

1. A device signs a payment instruction.
2. The instruction is encrypted for the gateway.
3. A bridge stores the encrypted packet in a local SQLite outbox.
4. The bridge delivers it to the gateway over HTTP.
5. The gateway validates the payment and settles it in PostgreSQL.
6. The bridge saves the gateway outcome.

The bridge can retain packets while gateway access is unavailable.
Settlement requires connectivity to the gateway and its database.

Bluetooth and device-to-device mesh transport are not implemented.

## Implemented features

- Device signatures and account ownership verification.
- Hybrid encryption of payment packets.
- Atomic settlement using simulated balances.
- Duplicate payment and counter-reuse protection.
- Persistent packet outcomes, including rejected payments.
- Bridge authentication, credential rotation, and revocation.
- Security headers, rate limits, and concurrency limits.
- Database and HTTP timeouts.
- Persistent bridge queues and retry schedules.
- Recovery after temporary gateway failure or a lost response.
- Process locking to prevent competing delivery runners.
- Graceful shutdown and local packet-result lookup.
- Queue capacity limits and manual completed-record cleanup.
- Automated checks in GitHub Actions.

## Development environment

The verified environment uses:

- Node.js 24.21.0
- npm
- PostgreSQL
- Bash in GitHub Codespaces

Install locked dependencies with:

```bash
npm ci
```

## Configuration and database setup

The project separates administrative database access from gateway runtime
access:

- `.env`: development configuration and administrative database connection.
- `.env.runtime`: gateway configuration using the restricted
  `gateway_runtime` database role.
- `.keys/`: private keys and bridge credentials.
- `.bridge-data/`: local queues and demo files.

Use `.env.example` and `src/config.ts` to check required configuration.
Do not commit credentials, private keys, environment files, or queue data.

For a fresh development database, after configuring administrative access:

```bash
npm run db:setup
npm run keys:generate
npm run db:setup-runtime
```

`db:setup` applies migrations and provisions runtime permissions.
`keys:generate` creates the server key pair.
`db:setup-runtime` provisions runtime login credentials.

The runtime-login setup writes `.keys/runtime-database.json`. Configure
`.env.runtime` with its `databaseUrl` as `DATABASE_URL`, together with any
other required runtime settings.

The normal `dev` and `start` scripts load `.env.runtime`.

These provisioning commands are not routine startup commands. Preserve
existing server keys: previously encrypted packets require the matching
private key.

## Run the gateway

In terminal 1:

```bash
npm run dev
```

The demo commands below assume port 8000.

In terminal 2:

```bash
curl --fail http://127.0.0.1:8000/ready
```

A ready gateway returns HTTP 200 and reports that the database is connected.

## Create and deliver a demo payment

Use terminal 2 with the development administrative configuration.

```bash
npm run demo:create
```

Each invocation creates a separate demo containing:

- Sender balance: ₹500.
- Receiver balance: ₹0.
- Payment amount: ₹100.
- A registered device and bridge.
- A signed, encrypted packet.
- A demo manifest and bridge credential file.

It prepares the payment but does not send it.

Copy the printed `demoId` when the following command asks for it:

```bash
read -r -p "Paste the demoId: " DEMO_ID

export BRIDGE_DATA_DIR=".bridge-data/demo-${DEMO_ID}/queue"
DEMO_PACKET=".bridge-data/demo-${DEMO_ID}/packet.json"
DEMO_CREDENTIAL=".keys/demo-${DEMO_ID}/bridge.json"
```

Enqueue the packet:

```bash
npm run bridge:enqueue -- "$DEMO_PACKET"
```

Expected event: `packet_queued`.

Deliver it:

```bash
npm run bridge:deliver-once -- \
  http://127.0.0.1:8000 \
  "$DEMO_CREDENTIAL"
```

Expected delivery status: `COMPLETED`.

For this funded demo, the expected gateway outcome is `SETTLED`, with a
transaction ID. The resulting simulated balances are ₹400 and ₹100.

Copy the printed `packetHash` when prompted:

```bash
read -r -p "Paste the packetHash: " DEMO_PACKET_HASH
npm run bridge:result -- "$DEMO_PACKET_HASH"
npm run bridge:status
```

Re-enqueuing the same packet in the same retained queue returns
`packet_already_known`. A completed packet is not sent again by the worker.

Keep the same saved packet when retrying uncertain delivery. Creating a new
demo creates a different payment.

When finished with this terminal's demo selection:

```bash
unset BRIDGE_DATA_DIR DEMO_ID DEMO_PACKET DEMO_CREDENTIAL DEMO_PACKET_HASH
```

This does not delete the demo's files or database records.

## Continuous delivery

After selecting a queue and setting `DEMO_CREDENTIAL` as above:

```bash
npm run bridge:run -- \
  http://127.0.0.1:8000 \
  "$DEMO_CREDENTIAL"
```

The runner checks for eligible packets and saves retry schedules when
delivery fails temporarily.

Press Ctrl+C once to request graceful shutdown.

An authentication failure pauses the queue. After correcting the
credential problem, explicitly resume it:

```bash
npm run bridge:resume
```

Then start delivery again. Resuming alone does not send a packet.

## Understanding delivery results

| Local status | Meaning |
| --- | --- |
| `NOT_FOUND` | No local record exists; it may have been pruned. |
| `PENDING` | No final response is saved; the packet may be waiting or sending. |
| `RETRY_SCHEDULED` | Delivery is waiting for its saved retry time. |
| `PAUSED` | Delivery is blocked by the queue's saved pause state. |
| `COMPLETED` | A final gateway outcome is stored. |

**Completed delivery does not necessarily mean successful payment.**

Inspect the stored gateway outcome:

- `SETTLED`: the gateway settled the instruction.
- `DUPLICATE`: the gateway recognized an already settled instruction.
- `REJECTED` or `INVALID`: the instruction did not settle successfully.

`NOT_FOUND` is a local lookup result, not proof of payment failure.

## Queue capacity and retention

Each queue accepts at most 10,000 stored packets, including completed
records. Existing duplicates remain recognizable when the queue is full.

```bash
npm run bridge:status
```

Status includes capacity, remaining slots, and whether the queue is full.

Manual cleanup:

```bash
npm run bridge:prune
```

Each invocation removes at most 100 records completed at least seven days
ago, together with their local outcomes and retry records.

Pending packets are never eligible. Cleanup is not automatic.

After pruning, local duplicate history for those packets is gone. Gateway
payment records remain separate and continue to enforce duplicate
settlement protection.

The capacity limit bounds packet count, not exact SQLite file size.

## CLI exit codes

| Command | Exit code | Meaning |
| --- | --- | --- |
| `bridge:enqueue` | 0 | Queued or already known. |
| `bridge:enqueue` | 4 | Queue full; the new packet was not accepted. |
| `bridge:deliver-once` | 0 | Completed delivery or no eligible work. |
| `bridge:deliver-once` | 2 | Retry scheduled. |
| `bridge:deliver-once` | 3 | Delivery paused. |
| `bridge:result` | 0 | Local record found; inspect its status and outcome. |
| `bridge:result` | 2 | Local record not found. |

Argument or operational errors generally return exit code 1.

## Verification

Baseline checks:

```bash
npm test
```

Bridge checks using temporary queues and local test servers:

```bash
npm run test:bridge
```

Crypto checks require server keys:

```bash
npm run test:crypto
```

Database checks require a configured development database and administrative
fixture access:

```bash
DB_CONNECTION_TIMEOUT_MS=60000 npm run test:db
```

HTTP checks require a running gateway and the configured test bridge
credential:

```bash
DB_CONNECTION_TIMEOUT_MS=60000 npm run test:http
```

The end-to-end bridge check requires the running gateway, matching server
keys, and administrative access to the same development database:

```bash
DB_CONNECTION_TIMEOUT_MS=60000 npm run check:bridge-gateway
```

It checks temporary unavailability, lost-response recovery, and settlement
without a duplicate transfer.

Build:

```bash
npm run build
```

GitHub Actions runs baseline, bridge, crypto, database, and HTTP integration
checks using a temporary PostgreSQL database.