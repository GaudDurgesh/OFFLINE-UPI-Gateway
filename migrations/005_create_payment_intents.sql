CREATE TABLE payment_intents (
    payment_id UUID PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id),
    counter BIGINT NOT NULL,
    payload_hash TEXT NOT NULL,
    first_packet_hash TEXT NOT NULL UNIQUE
        REFERENCES packets(packet_hash),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT payment_intents_unique_device_counter
        UNIQUE (device_id, counter),

    CONSTRAINT payment_intents_counter_positive
        CHECK (counter > 0),

    CONSTRAINT payment_intents_valid_payload_hash
        CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);