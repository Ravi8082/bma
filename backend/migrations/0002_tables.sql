-- 0002_tables.sql
--
-- Phase 1 tables. Money is integer paise everywhere; there is no NUMERIC and no float.
-- Every shop-owned table carries shop_id NOT NULL so RLS and composite foreign keys can
-- use the same tenant key.

CREATE TABLE app.shops (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  preset_key          text NOT NULL CHECK (preset_key ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  language            text NOT NULL DEFAULT 'hi' CHECK (language IN ('hi','mr','en','hinglish')),
  timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
  status              text NOT NULL DEFAULT 'ONBOARDING'
                        CHECK (status IN ('ONBOARDING','ACTIVE','SUSPENDED','CLOSED')),
  onboarded_at        timestamptz,
  trial_ends_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX ix_shops_status_trial ON app.shops (status, trial_ends_at);

CREATE TABLE app.customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  name_normalized     text NOT NULL CHECK (length(btrim(name_normalized)) BETWEEN 1 AND 80),
  phone_enc           bytea,
  phone_bidx          bytea,
  address_enc         bytea,
  notes_enc           bytea,
  key_version         smallint NOT NULL DEFAULT 1 CHECK (key_version > 0),
  language            text CHECK (language IS NULL OR language IN ('hi','mr','en','hinglish')),
  balance_paise       bigint NOT NULL DEFAULT 0
                        CHECK (balance_paise BETWEEN -100000000000 AND 100000000000),
  opted_out_at        timestamptz,
  merged_into_id      uuid,
  last_transaction_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),

  CONSTRAINT customers_shop_id_id_unique UNIQUE (shop_id, id),
  CONSTRAINT customers_phone_pair_chk CHECK (
    (phone_enc IS NULL AND phone_bidx IS NULL)
    OR (phone_enc IS NOT NULL AND phone_bidx IS NOT NULL)
  ),
  CONSTRAINT customers_merged_same_shop_fk
    FOREIGN KEY (shop_id, merged_into_id) REFERENCES app.customers (shop_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX customers_phone_bidx_unique
  ON app.customers (shop_id, phone_bidx)
  WHERE phone_bidx IS NOT NULL;
CREATE INDEX ix_customers_shop_name ON app.customers (shop_id, name_normalized);
CREATE INDEX ix_customers_shop_last_tx ON app.customers (shop_id, last_transaction_at DESC);

CREATE TABLE app.ledger_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  customer_id         uuid,
  posting_id          uuid NOT NULL,
  entry_seq           smallint NOT NULL CHECK (entry_seq > 0),
  entry_type          text NOT NULL CHECK (entry_type IN (
                        'SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','EXPENSE',
                        'REFUND','SALES_RETURN','OPENING_BALANCE','ADJUSTMENT','REVERSAL')),
  direction           text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise        bigint NOT NULL CHECK (amount_paise >= 0 AND amount_paise <= 100000000000),
  currency            char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  occurred_at         timestamptz NOT NULL,
  description         text CHECK (description IS NULL OR length(description) <= 500),
  source              text NOT NULL CHECK (source IN ('WHATSAPP','DASHBOARD','IMPORT','SYSTEM')),
  source_id           text,
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_by          text NOT NULL CHECK (length(btrim(created_by)) > 0),
  reverses_entry_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_entries_shop_id_id_unique UNIQUE (shop_id, id),
  CONSTRAINT ledger_entries_posting_seq_unique UNIQUE (shop_id, posting_id, entry_seq),
  CONSTRAINT ledger_entries_idempotency_unique UNIQUE (shop_id, idempotency_key),
  CONSTRAINT ledger_entries_reversal_chk CHECK (
    (entry_type = 'REVERSAL' AND reverses_entry_id IS NOT NULL)
    OR (entry_type <> 'REVERSAL' AND reverses_entry_id IS NULL)
  ),
  CONSTRAINT ledger_entries_reverses_same_shop_fk
    FOREIGN KEY (shop_id, reverses_entry_id)
    REFERENCES app.ledger_entries (shop_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ledger_entries_customer_same_shop_fk
    FOREIGN KEY (shop_id, customer_id)
    REFERENCES app.customers (shop_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ledger_entries_one_reversal
  ON app.ledger_entries (shop_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX ix_ledger_entries_shop_customer
  ON app.ledger_entries (shop_id, customer_id, occurred_at DESC);
CREATE INDEX ix_ledger_entries_shop_occurred
  ON app.ledger_entries (shop_id, occurred_at DESC);
CREATE INDEX ix_ledger_entries_shop_posting
  ON app.ledger_entries (shop_id, posting_id);

CREATE TABLE app.whatsapp_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  wa_message_id     text NOT NULL CHECK (length(wa_message_id) BETWEEN 1 AND 200),
  direction         text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  message_type      text NOT NULL CHECK (message_type IN (
                      'TEXT','AUDIO','IMAGE','DOCUMENT','INTERACTIVE','TEMPLATE','SYSTEM')),
  from_phone_enc    bytea,
  from_phone_bidx   bytea,
  to_phone_enc      bytea,
  to_phone_bidx     bytea,
  raw_payload       jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(raw_payload) = 'object'),
  body              jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(body) = 'object'),
  body_hash         bytea,
  status            text NOT NULL DEFAULT 'RECEIVED'
                      CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED',
                                        'SENT','DELIVERED','READ','FAILED','IGNORED')),
  received_at       timestamptz,
  processed_at      timestamptz,
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_messages_wa_unique UNIQUE (shop_id, wa_message_id)
);

CREATE INDEX ix_whatsapp_messages_shop_received
  ON app.whatsapp_messages (shop_id, received_at DESC);
CREATE INDEX ix_whatsapp_messages_bidx
  ON app.whatsapp_messages (shop_id, from_phone_bidx);

CREATE TABLE app.idempotency_keys (
  shop_id         uuid NOT NULL REFERENCES app.shops(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (length(btrim(scope)) BETWEEN 1 AND 80),
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash    bytea NOT NULL,
  status          text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,

  PRIMARY KEY (shop_id, scope, key),
  CONSTRAINT idempotency_keys_completed_chk CHECK (
    (status = 'COMPLETED' AND response_status IS NOT NULL)
    OR (status <> 'COMPLETED')
  )
);

CREATE INDEX ix_idempotency_keys_expiry ON app.idempotency_keys (expires_at);

CREATE TABLE app.audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  actor_type      text NOT NULL CHECK (actor_type IN ('USER','ADMIN','SUPPORT','SYSTEM','CUSTOMER')),
  actor_id        text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  action          text NOT NULL CHECK (length(btrim(action)) BETWEEN 3 AND 100),
  entity_type     text,
  entity_id       text,
  before          jsonb,
  after           jsonb,
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  request_id      text,
  ip_hash         bytea,
  user_agent_hash bytea,
  sensitive_view  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_audit_logs_shop_created ON app.audit_logs (shop_id, created_at DESC);
CREATE INDEX ix_audit_logs_entity ON app.audit_logs (shop_id, entity_type, entity_id, created_at DESC);
CREATE INDEX ix_audit_logs_actor ON app.audit_logs (shop_id, actor_id, created_at DESC);

CREATE TABLE app.security_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  event_type      text NOT NULL CHECK (length(btrim(event_type)) BETWEEN 3 AND 100),
  severity        text NOT NULL CHECK (severity IN ('INFO','WARN','HIGH','CRITICAL')),
  actor_ref       text,
  ip_hash         bytea,
  user_agent_hash bytea,
  request_id      text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(detail) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_security_events_occurred ON app.security_events (occurred_at DESC);
CREATE INDEX ix_security_events_type ON app.security_events (event_type, occurred_at DESC);

COMMENT ON COLUMN app.customers.name IS
  'Not encrypted by decision: seller-facing search must work on names.';
COMMENT ON COLUMN app.customers.phone_enc IS
  'Envelope-encrypted phone. The key lives in the KMS; only key_version is stored here.';
COMMENT ON COLUMN app.ledger_entries.amount_paise IS
  'Non-negative integer paise. Direction carries the sign. BIGINT, never NUMERIC or float.';
COMMENT ON COLUMN app.whatsapp_messages.body_hash IS
  'SHA-256 of the raw request body, used to reject replayed webhooks.';
COMMENT ON COLUMN app.whatsapp_messages.raw_payload IS
  'Redacted provider payload committed before queueing. Retained for 30 days only.';
