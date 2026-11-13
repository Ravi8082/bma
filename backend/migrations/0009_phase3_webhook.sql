-- 0009_phase3_webhook.sql
--
-- Phase 3: webhook inbox, outbound outbox, media storage.
-- Lease-based inbox replaces session-level advisory locks. All shop-owned tables
-- carry shop_id NOT NULL and FORCE RLS.

-- Inbox: persisted raw WhatsApp messages, claimed by workers with leases.
CREATE TABLE app.inbox_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  wa_message_id     text NOT NULL CHECK (length(wa_message_id) BETWEEN 1 AND 200),
  direction         text NOT NULL DEFAULT 'INBOUND' CHECK (direction IN ('INBOUND')),
  from_phone_bidx   bytea,
  message_type      text NOT NULL CHECK (message_type IN (
                      'TEXT','AUDIO','IMAGE','DOCUMENT','INTERACTIVE','TEMPLATE','SYSTEM','STICKER','LOCATION','REACTION','CONTACT','GROUP','UNKNOWN')),
  body              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(body) = 'object'),
  raw_payload       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw_payload) = 'object'),
  body_hash         bytea NOT NULL,
  status            text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSING','DONE','FAILED','DEAD')),
  lease_until       timestamptz,
  attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  arrival_seq       bigint NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),

  CONSTRAINT inbox_messages_wa_unique UNIQUE (shop_id, wa_message_id)
);

CREATE INDEX ix_inbox_messages_status_received ON app.inbox_messages (status, received_at);
CREATE INDEX ix_inbox_messages_shop_received ON app.inbox_messages (shop_id, received_at);
CREATE INDEX ix_inbox_messages_lease ON app.inbox_messages (lease_until) WHERE status = 'PROCESSING';

CREATE TRIGGER inbox_messages_touch
  BEFORE UPDATE ON app.inbox_messages
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

-- Outbox: outbound messages with delivery state tracking.
CREATE TABLE app.outbox_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  message_id        uuid NOT NULL,
  recipient_phone_bidx bytea NOT NULL,
  message_type      text NOT NULL CHECK (message_type IN ('TEXT','TEMPLATE','DOCUMENT','IMAGE','AUDIO')),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  state             text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','SENDING','SENT','UNKNOWN','FAILED','DEAD')),
  attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error        text,
  queued_at         timestamptz NOT NULL DEFAULT now(),
  sending_at        timestamptz,
  sent_at           timestamptz,
  failed_at         timestamptz,
  provider_message_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),

  CONSTRAINT outbox_events_shop_message_unique UNIQUE (shop_id, message_id)
);

CREATE INDEX ix_outbox_events_state_queued ON app.outbox_events (state, queued_at);
CREATE INDEX ix_outbox_events_shop_queued ON app.outbox_events (shop_id, queued_at);

CREATE TRIGGER outbox_events_touch
  BEFORE UPDATE ON app.outbox_events
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

-- Media assets: encrypted media storage.
CREATE TABLE app.media_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  message_id        uuid,
  media_type        text NOT NULL CHECK (media_type IN ('AUDIO','IMAGE','DOCUMENT','VIDEO')),
  mime_type         text NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 100),
  size_bytes        integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 16777216),
  storage_key       text NOT NULL,
  encryption_key_version smallint NOT NULL DEFAULT 1 CHECK (encryption_key_version > 0),
  checksum          bytea NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_media_assets_shop_created ON app.media_assets (shop_id, created_at DESC);

-- Status updates: monotonic delivery state tracking.
CREATE TABLE app.message_status_updates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  message_id        uuid NOT NULL,
  provider_message_id text,
  status            text NOT NULL CHECK (status IN ('SENT','DELIVERED','READ','FAILED')),
  occurred_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_status_unique UNIQUE (shop_id, message_id, status, occurred_at)
);

CREATE INDEX ix_message_status_shop_message ON app.message_status_updates (shop_id, message_id, occurred_at);

-- SECURITY DEFINER: claim the next inbox message for a seller.
-- Returns only id and shop_id. No business data. Pinned search_path.
CREATE OR REPLACE FUNCTION app.claim_next_inbox_message(p_shop_id uuid)
RETURNS TABLE (message_id uuid, shop_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT im.id, im.shop_id
  FROM app.inbox_messages im
  WHERE im.shop_id = p_shop_id
    AND im.status = 'RECEIVED'
    AND NOT EXISTS (
      SELECT 1 FROM app.inbox_messages earlier
      WHERE earlier.shop_id = im.shop_id
        AND earlier.status IN ('RECEIVED', 'PROCESSING')
        AND earlier.arrival_seq < im.arrival_seq
    )
  ORDER BY im.arrival_seq
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
$$;

COMMENT ON FUNCTION app.claim_next_inbox_message(uuid) IS
  'Claims the next inbox message for a shop. Returns only id and shop_id. No business data.';

REVOKE ALL ON FUNCTION app.claim_next_inbox_message(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_next_inbox_message(uuid) TO bma_app;

-- SECURITY DEFINER: cross-tenant claim for the sweeper.
-- Returns only id and shop_id. No business data. Audited via caller.
CREATE OR REPLACE FUNCTION app.claim_next_inbox_message_global()
RETURNS TABLE (message_id uuid, shop_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT im.id, im.shop_id
  FROM app.inbox_messages im
  WHERE im.status = 'RECEIVED'
    AND (im.lease_until IS NULL OR im.lease_until < now())
    AND NOT EXISTS (
      SELECT 1 FROM app.inbox_messages earlier
      WHERE earlier.shop_id = im.shop_id
        AND earlier.status IN ('RECEIVED', 'PROCESSING')
        AND earlier.arrival_seq < im.arrival_seq
    )
  ORDER BY im.received_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
$$;

COMMENT ON FUNCTION app.claim_next_inbox_message_global() IS
  'Global sweeper claim. Returns only id and shop_id. No business data.';

REVOKE ALL ON FUNCTION app.claim_next_inbox_message_global() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_next_inbox_message_global() TO bma_app;

-- RLS for shop-owned tables.
ALTER TABLE app.inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.inbox_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_messages_tenant_isolation ON app.inbox_messages
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_tenant_isolation ON app.outbox_events
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

ALTER TABLE app.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY media_assets_tenant_isolation ON app.media_assets
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

ALTER TABLE app.message_status_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_status_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY message_status_updates_tenant_isolation ON app.message_status_updates
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- Grants.
GRANT SELECT, INSERT, UPDATE ON app.inbox_messages TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.outbox_events TO bma_app;
GRANT SELECT, INSERT ON app.media_assets TO bma_app;
GRANT SELECT, INSERT ON app.message_status_updates TO bma_app;

-- Reporting: read-only, column-restricted.
GRANT SELECT (id, shop_id, message_type, status, received_at, processed_at, attempt_count) ON app.inbox_messages TO bma_reporting;
GRANT SELECT (id, shop_id, message_type, state, queued_at, sent_at, failed_at) ON app.outbox_events TO bma_reporting;
GRANT SELECT (id, shop_id, media_type, mime_type, size_bytes, fetched_at) ON app.media_assets TO bma_reporting;
GRANT SELECT (id, shop_id, status, occurred_at) ON app.message_status_updates TO bma_reporting;
GRANT EXECUTE ON FUNCTION app.claim_next_inbox_message(uuid) TO bma_reporting;
GRANT EXECUTE ON FUNCTION app.claim_next_inbox_message_global() TO bma_reporting;
