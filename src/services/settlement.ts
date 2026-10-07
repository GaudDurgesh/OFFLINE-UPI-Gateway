import { z } from "zod";
import { withTransaction } from "../db/tx.js";

const MAX_PAISE = 9223372036854775807n;

const uuid = z.string().uuid().transform((value) => value.toLowerCase());

const settlementSchema = z.object({
  paymentId: uuid,
  senderAccountId: uuid,
  receiverAccountId: uuid,
  amountPaise: z.bigint().positive().max(MAX_PAISE),
});

type SettlementInput = z.input<typeof settlementSchema>;

type SettlementResult =
  | {
      status: "SETTLED" | "DUPLICATE";
      transactionId: string;
    }
  | {
      status: "REJECTED";
      reason:
        | "INVALID_INPUT"
        | "SAME_ACCOUNT"
        | "UNKNOWN_ACCOUNT"
        | "INSUFFICIENT_FUNDS"
        | "RECEIVER_BALANCE_LIMIT"
        | "PAYMENT_ID_CONFLICT";
    };

type AccountRow = {
  id: string;
  balance_paise: string;
};

type TransactionRow = {
  id: string;
  sender_account_id: string;
  receiver_account_id: string;
  amount_paise: string;
};

export async function settle(
  input: SettlementInput,
): Promise<SettlementResult> {
  const parsed = settlementSchema.safeParse(input);

  if (!parsed.success) {
    return { status: "REJECTED", reason: "INVALID_INPUT" };
  }

  const {
    paymentId,
    senderAccountId,
    receiverAccountId,
    amountPaise,
  } = parsed.data;

  if (senderAccountId === receiverAccountId) {
    return { status: "REJECTED", reason: "SAME_ACCOUNT" };
  }

  return withTransaction<SettlementResult>(async (client) => {
    // Serialize attempts using the same payment ID.
    await client.query(
      "SELECT pg_advisory_xact_lock(81002, hashtext($1))",
      [paymentId],
    );

    const existing = await client.query<TransactionRow>(
      `SELECT id, sender_account_id, receiver_account_id, amount_paise
       FROM transactions
       WHERE payment_id = $1`,
      [paymentId],
    );

    const previous = existing.rows[0];

    if (previous) {
      const samePayment =
        previous.sender_account_id === senderAccountId &&
        previous.receiver_account_id === receiverAccountId &&
        BigInt(previous.amount_paise) === amountPaise;

      if (!samePayment) {
        return { status: "REJECTED", reason: "PAYMENT_ID_CONFLICT" };
      }

      return { status: "DUPLICATE", transactionId: previous.id };
    }

    // Always lock account rows in the same order.
    const accounts = await client.query<AccountRow>(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id IN ($1, $2)
       ORDER BY id
       FOR UPDATE`,
      [senderAccountId, receiverAccountId],
    );

    const sender = accounts.rows.find(
      (account) => account.id === senderAccountId,
    );
    const receiver = accounts.rows.find(
      (account) => account.id === receiverAccountId,
    );

    if (!sender || !receiver) {
      return { status: "REJECTED", reason: "UNKNOWN_ACCOUNT" };
    }

    if (BigInt(sender.balance_paise) < amountPaise) {
      return { status: "REJECTED", reason: "INSUFFICIENT_FUNDS" };
    }

    if (BigInt(receiver.balance_paise) + amountPaise > MAX_PAISE) {
      return { status: "REJECTED", reason: "RECEIVER_BALANCE_LIMIT" };
    }

    const amount = amountPaise.toString();

    await client.query(
      `UPDATE accounts
       SET balance_paise = balance_paise - $1::bigint
       WHERE id = $2`,
      [amount, senderAccountId],
    );

    await client.query(
      `UPDATE accounts
       SET balance_paise = balance_paise + $1::bigint
       WHERE id = $2`,
      [amount, receiverAccountId],
    );

    const transaction = await client.query<{ id: string }>(
      `INSERT INTO transactions (
         payment_id, sender_account_id, receiver_account_id, amount_paise
       )
       VALUES ($1, $2, $3, $4::bigint)
       RETURNING id`,
      [paymentId, senderAccountId, receiverAccountId, amount],
    );

    return {
      status: "SETTLED",
      transactionId: transaction.rows[0]!.id,
    };
  });
}