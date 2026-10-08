CREATE TABLE bridge_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT bridge_nodes_name_not_empty
        CHECK (length(trim(name)) > 0),

    CONSTRAINT bridge_nodes_valid_key_hash
        CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),

    CONSTRAINT bridge_nodes_valid_status
        CHECK (status IN ('active', 'revoked'))
);