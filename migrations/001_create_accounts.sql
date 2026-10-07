CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vpa TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    balance_paise BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT accounts_balance_nonnegative
        CHECK (balance_paise >= 0),

    CONSTRAINT accounts_vpa_not_empty
        CHECK (length(trim(vpa)) > 0),

    CONSTRAINT accounts_name_not_empty
        CHECK (length(trim(name)) > 0)
);