CREATE TABLE transactions (
    id BIGSERIAL PRIMARY KEY,
    payment_id UUID NOT NULL UNIQUE,
    sender_account_id UUID NOT NULL REFERENCES accounts(id),
    receiver_account_id UUID NOT NULL REFERENCES accounts(id),
    amount_paise BIGINT NOT NULL,
    settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT transactions_amount_positive
        CHECK (amount_paise > 0),

    CONSTRAINT transactions_different_accounts
        CHECK (sender_account_id <> receiver_account_id)
);

CREATE INDEX transactions_sender_idx
    ON transactions (sender_account_id);

CREATE INDEX transactions_receiver_idx
    ON transactions (receiver_account_id);