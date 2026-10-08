CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    public_key_pem TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT devices_valid_status
        CHECK (status IN ('active', 'revoked')),

    CONSTRAINT devices_public_key_not_empty
        CHECK (length(trim(public_key_pem)) > 0)
);

CREATE INDEX devices_account_idx
    ON devices (account_id);