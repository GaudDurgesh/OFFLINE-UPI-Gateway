-- Run as the database administrator after migrations 001–006.
-- Creates the runtime role if missing and applies its required grants.
-- Existing login credentials remain unchanged.

BEGIN;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'gateway_runtime'
  ) THEN
    CREATE ROLE gateway_runtime
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'gateway_runtime'
      AND (
        rolsuper OR rolcreatedb OR rolcreaterole
        OR rolreplication OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'gateway_runtime has unexpected administrative privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'gateway_runtime'
  ) THEN
    RAISE EXCEPTION 'gateway_runtime has unexpected role memberships';
  END IF;
END;
$block$;

-- Grant access to the database where this script is executed.
DO $block$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO gateway_runtime',
    current_database()
  );
END;
$block$;

GRANT USAGE ON SCHEMA public TO gateway_runtime;

GRANT SELECT ON
  public.accounts,
  public.devices,
  public.bridge_nodes,
  public.transactions,
  public.packets,
  public.payment_intents
TO gateway_runtime;

GRANT UPDATE (balance_paise)
ON public.accounts
TO gateway_runtime;

GRANT INSERT (
  payment_id,
  sender_account_id,
  receiver_account_id,
  amount_paise
)
ON public.transactions
TO gateway_runtime;

GRANT USAGE ON SEQUENCE public.transactions_id_seq
TO gateway_runtime;

GRANT INSERT (packet_hash)
ON public.packets
TO gateway_runtime;

GRANT UPDATE (status, transaction_id, reason)
ON public.packets
TO gateway_runtime;

GRANT INSERT (
  payment_id,
  device_id,
  counter,
  payload_hash,
  first_packet_hash
)
ON public.payment_intents
TO gateway_runtime;

COMMIT;