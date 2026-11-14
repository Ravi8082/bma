-- 0010_text_slice.sql
--
-- Vertical slice: TEXT message -> inbox -> draft -> seller confirmation -> ledger.
-- Money stays integer paise. Every shop-owned table carries shop_id NOT NULL and FORCE RLS.
-- The ledger remains append-only; approval writes one INSERT and nothing else.

-- Entry drafts: a parsed inbound message waiting for seller approval.
CREATE TABLE app.entry_drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  source_message_id   uuid NOT NULL REFERENCES app.inbox_messages(id) ON DELETE RESTRICT,
  wa_message_id       text NOT NULL CHECK (length(wa_message_id) BETWEEN 1 AND 200),
  customer_id         uuid,
  customer_name       text NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 80),
  entry_type          text NOT NULL CHECK (entry_type IN ('SALE','PAYMENT_IN','PURCHASE','PAYMENT_OUT','EXPENSE')),
  direction           text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise        bigint NOT NULL CHECK (amount_paise >= 0 AND amount_paise <= 100000000000),
  currency            char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  is_credit_sale      boolean NOT NULL DEFAULT true,
  raw_text            text NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 1000),
  source_tag          text NOT NULL DEFAULT 'SELLER' CHECK (source_tag IN ('SELLER','CUSTOMER_REQUEST','DELIVERY_ORDER')),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
  seller_phone_enc    bytea NOT NULL,
  seller_phone_bidx   bytea NOT NULL,
  key_version         smallint NOT NULL DEFAULT 1 CHECK (key_version > 0),
  confirmed_entry_id  uuid,
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),

  CONSTRAINT entry_drafts_shop_source_unique UNIQUE (shop_id, source_message_id),
  CONSTRAINT entry_drafts_shop_customer_fk
    FOREIGN KEY (shop_id, customer_id) REFERENCES app.customers (shop_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT entry_drafts_shop_confirmed_fk
    FOREIGN KEY (shop_id, confirmed_entry_id) REFERENCES app.ledger_entries (shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX ix_entry_drafts_shop_status ON app.entry_drafts (shop_id, status, created_at DESC);
CREATE INDEX ix_entry_drafts_shop_customer ON app.entry_drafts (shop_id, customer_id, created_at DESC);

CREATE TRIGGER entry_drafts_touch
  BEFORE UPDATE ON app.entry_drafts
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

ALTER TABLE app.entry_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.entry_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY entry_drafts_tenant_isolation ON app.entry_drafts
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

GRANT SELECT, INSERT, UPDATE ON app.entry_drafts TO bma_app;
GRANT SELECT (id, shop_id, customer_id, entry_type, direction, amount_paise, currency,
              source_tag, status, confirmed_entry_id, created_at, confirmed_at, cancelled_at)
  ON app.entry_drafts TO bma_reporting;

COMMENT ON TABLE app.entry_drafts IS
  'Parsed inbound entries waiting for seller approval. Confirmation posts exactly one ledger row.';

-- The outbound sender needs the recipient phone. It is encrypted with AAD bound to this
-- table and column, never stored in clear text. next_attempt_at gives failed sends a
-- bounded backoff without changing the state machine.
ALTER TABLE app.outbox_events ADD COLUMN recipient_phone_enc bytea;
ALTER TABLE app.outbox_events ADD COLUMN key_version smallint NOT NULL DEFAULT 1 CHECK (key_version > 0);
ALTER TABLE app.outbox_events ADD COLUMN next_attempt_at timestamptz;

-- Retryable claims: RECEIVED and FAILED (after backoff) are claimable. PROCESSING is not,
-- unless its lease has expired and the sweeper has reset it. Arrival sequence is the order.
CREATE OR REPLACE FUNCTION app.claim_next_inbox_message(p_shop_id uuid)
RETURNS TABLE (message_id uuid, shop_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  RETURN QUERY
    SELECT im.id, im.shop_id
    FROM app.inbox_messages im
    WHERE im.shop_id = p_shop_id
      AND im.status IN ('RECEIVED', 'FAILED')
      AND (im.lease_until IS NULL OR im.lease_until < now())
      AND NOT EXISTS (
        SELECT 1 FROM app.inbox_messages earlier
        WHERE earlier.shop_id = im.shop_id
          AND earlier.status IN ('RECEIVED', 'PROCESSING', 'FAILED')
          AND earlier.arrival_seq < im.arrival_seq
      )
    ORDER BY im.arrival_seq
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
END;
$$;

CREATE OR REPLACE FUNCTION app.claim_next_inbox_message_global()
RETURNS TABLE (message_id uuid, shop_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  RETURN QUERY
    SELECT im.id, im.shop_id
    FROM app.inbox_messages im
    WHERE im.status IN ('RECEIVED', 'FAILED')
      AND (im.lease_until IS NULL OR im.lease_until < now())
      AND NOT EXISTS (
        SELECT 1 FROM app.inbox_messages earlier
        WHERE earlier.shop_id = im.shop_id
          AND earlier.status IN ('RECEIVED', 'PROCESSING', 'FAILED')
          AND earlier.arrival_seq < im.arrival_seq
      )
    ORDER BY im.arrival_seq
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
END;
$$;

-- Scheduler fan-out: returns identifiers only, never message content.
CREATE OR REPLACE FUNCTION app.list_shop_ids_with_pending_inbox()
RETURNS TABLE (shop_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT DISTINCT im.shop_id
  FROM app.inbox_messages im
  WHERE im.status IN ('RECEIVED', 'FAILED')
    AND (im.lease_until IS NULL OR im.lease_until < now());
$$;

CREATE OR REPLACE FUNCTION app.list_shop_ids_with_queued_outbox()
RETURNS TABLE (shop_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT DISTINCT oe.shop_id
  FROM app.outbox_events oe
  WHERE oe.state IN ('QUEUED', 'FAILED')
    AND (oe.next_attempt_at IS NULL OR oe.next_attempt_at <= now());
$$;

REVOKE ALL ON FUNCTION app.list_shop_ids_with_pending_inbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_shop_ids_with_queued_outbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_shop_ids_with_pending_inbox() TO bma_app;
GRANT EXECUTE ON FUNCTION app.list_shop_ids_with_queued_outbox() TO bma_app;
