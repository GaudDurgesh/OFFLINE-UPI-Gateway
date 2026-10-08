CREATE TABLE packets (
    packet_hash TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'PROCESSING',
    transaction_id BIGINT REFERENCES transactions(id),
    reason TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT packets_valid_hash
        CHECK (packet_hash ~ '^[0-9a-f]{64}$'),

    CONSTRAINT packets_valid_status
        CHECK (
            status IN (
                'PROCESSING',
                'SETTLED',
                'DUPLICATE',
                'INVALID',
                'REJECTED'
            )
        ),

    CONSTRAINT packets_transaction_matches_status
        CHECK (
            (status IN ('SETTLED', 'DUPLICATE'))
            = (transaction_id IS NOT NULL)
        ),

    CONSTRAINT packets_reason_matches_status
        CHECK (
            (status IN ('INVALID', 'REJECTED'))
            = (reason IS NOT NULL)
        )
);