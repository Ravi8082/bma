-- 0006_identity_tables.sql
--
-- Phase 2 identity, tenancy and onboarding tables. Money is still integer paise;
-- no new money columns are introduced here. Every shop-owned table carries
-- shop_id NOT NULL and is protected by FORCE RLS.

-- Shop settings: per-shop configuration, including the selected preset and feature flags.
CREATE TABLE app.shop_settings (
  shop_id           uuid PRIMARY KEY REFERENCES app.shops(id) ON DELETE RESTRICT,
  preset_key        text NOT NULL CHECK (preset_key ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  presets_version   integer NOT NULL DEFAULT 1 CHECK (presets_version > 0),
  language          text NOT NULL DEFAULT 'hi' CHECK (language IN ('hi','mr','en','hinglish')),
  timezone          text NOT NULL DEFAULT 'Asia/Kolkata',
  visible_modules   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(visible_modules) = 'array'),
  vocabulary_hints  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(vocabulary_hints) = 'object'),
  default_report    text,
  template_set      text,
  units             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(units) = 'array'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TRIGGER shop_settings_touch
  BEFORE UPDATE ON app.shop_settings
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

-- Users: sellers and helpers. Phone is encrypted with a blind index for lookup.
CREATE TABLE app.users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  role              text NOT NULL CHECK (role IN ('OWNER', 'HELPER')),
  name              text CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 80),
  phone_enc         bytea NOT NULL,
  phone_bidx        bytea NOT NULL,
  key_version       smallint NOT NULL DEFAULT 1 CHECK (key_version > 0),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'PENDING')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),

  CONSTRAINT users_shop_id_id_unique UNIQUE (shop_id, id),
  CONSTRAINT users_phone_pair_chk CHECK (
    (phone_enc IS NOT NULL AND phone_bidx IS NOT NULL)
  )
);

CREATE UNIQUE INDEX users_phone_bidx_unique
  ON app.users (phone_bidx)
  WHERE status = 'ACTIVE';

CREATE INDEX ix_users_shop_role ON app.users (shop_id, role);

CREATE TRIGGER users_touch
  BEFORE UPDATE ON app.users
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

-- Plans: reference data, versioned, loaded by seed.
CREATE TABLE app.plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key          text NOT NULL UNIQUE CHECK (plan_key ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  trial_days        integer NOT NULL DEFAULT 14 CHECK (trial_days >= 0 AND trial_days <= 365),
  features          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER plans_touch
  BEFORE UPDATE ON app.plans
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

-- Subscriptions: one per shop, tracks trial and plan status.
CREATE TABLE app.subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  plan_id           uuid NOT NULL REFERENCES app.plans(id) ON DELETE RESTRICT,
  status            text NOT NULL DEFAULT 'TRIAL' CHECK (status IN ('TRIAL', 'ACTIVE', 'GRACE', 'SUSPENDED', 'CANCELLED')),
  trial_ends_at     timestamptz,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),

  CONSTRAINT subscriptions_shop_unique UNIQUE (shop_id)
);

CREATE INDEX ix_subscriptions_status_trial ON app.subscriptions (status, trial_ends_at);

CREATE TRIGGER subscriptions_touch
  BEFORE UPDATE ON app.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

-- Consent records: versioned, append-only per purpose.
CREATE TABLE app.consent_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL,
  purpose           text NOT NULL CHECK (purpose IN ('BOOKKEEPING', 'MARKETING', 'ANALYTICS', 'EXPORT')),
  granted           boolean NOT NULL,
  policy_version    text NOT NULL CHECK (length(btrim(policy_version)) BETWEEN 1 AND 40),
  method            text NOT NULL CHECK (method IN ('WHATSAPP', 'DASHBOARD', 'IMPORT')),
  evidence_message_id text,
  granted_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT consent_records_shop_user_fk
    FOREIGN KEY (shop_id, user_id) REFERENCES app.users (shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX ix_consent_shop_user_purpose ON app.consent_records (shop_id, user_id, purpose, granted_at DESC);

-- Onboarding state: persisted per conversation, resumable.
CREATE TABLE app.onboarding_state (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  conversation_id   text NOT NULL,
  state             text NOT NULL CHECK (state IN (
                      'AWAITING_LANGUAGE', 'AWAITING_SHOP_NAME', 'AWAITING_CATEGORY',
                      'AWAITING_CONSENT', 'AWAITING_FIRST_ENTRY_DEMO', 'COMPLETE')),
  language          text CHECK (language IS NULL OR language IN ('hi','mr','en','hinglish')),
  shop_name         text CHECK (shop_name IS NULL OR length(btrim(shop_name)) BETWEEN 1 AND 80),
  preset_key        text CHECK (preset_key IS NULL OR preset_key ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  invalid_count     integer NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  last_message_id   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),

  CONSTRAINT onboarding_state_shop_conversation_unique UNIQUE (shop_id, conversation_id)
);

CREATE INDEX ix_onboarding_shop_state ON app.onboarding_state (shop_id, state);

CREATE TRIGGER onboarding_state_touch
  BEFORE UPDATE ON app.onboarding_state
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

-- Phone number change requests: cooling-off period.
CREATE TABLE app.phone_change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL,
  old_phone_bidx    bytea NOT NULL,
  new_phone_enc     bytea NOT NULL,
  new_phone_bidx    bytea NOT NULL,
  new_key_version   smallint NOT NULL CHECK (new_key_version > 0),
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  effective_at      timestamptz NOT NULL,
  cancelled_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT phone_change_shop_user_fk
    FOREIGN KEY (shop_id, user_id) REFERENCES app.users (shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX ix_phone_change_shop_status ON app.phone_change_requests (shop_id, status);

-- Helper assignments: owner confirmation required.
CREATE TABLE app.helper_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  helper_user_id    uuid NOT NULL,
  owner_user_id     uuid NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'REVOKED')),
  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helper_assign_shop_helper_fk
    FOREIGN KEY (shop_id, helper_user_id) REFERENCES app.users (shop_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT helper_assign_shop_owner_fk
    FOREIGN KEY (shop_id, owner_user_id) REFERENCES app.users (shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX ix_helper_assign_shop_status ON app.helper_assignments (shop_id, status);

-- Export requests: WhatsApp-confirmed, daily limit.
CREATE TABLE app.export_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
  download_token    text,
  download_expires_at timestamptz,
  downloaded_at     timestamptz,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT export_req_shop_user_fk
    FOREIGN KEY (shop_id, user_id) REFERENCES app.users (shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX ix_export_req_shop_requested ON app.export_requests (shop_id, requested_at DESC);

-- Deletion requests: cooling-off period.
CREATE TABLE app.deletion_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'COOLING_OFF', 'CANCELLED', 'COMPLETED')),
  cooling_off_ends_at timestamptz,
  cancelled_at      timestamptz,
  completed_at      timestamptz,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deletion_req_shop_user_fk
    FOREIGN KEY (shop_id, user_id) REFERENCES app.users (shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX ix_deletion_req_shop_status ON app.deletion_requests (shop_id, status);

-- Feature flags: per-shop overrides.
CREATE TABLE app.feature_flags (
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  flag_name         text NOT NULL CHECK (length(btrim(flag_name)) BETWEEN 1 AND 80),
  enabled           boolean NOT NULL,
  override          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),

  PRIMARY KEY (shop_id, flag_name)
);

CREATE TRIGGER feature_flags_touch
  BEFORE UPDATE ON app.feature_flags
  FOR EACH ROW
  EXECUTE FUNCTION app.touch_versioned_row();

COMMENT ON TABLE app.shop_settings IS 'Per-shop configuration, including the selected preset.';
COMMENT ON TABLE app.users IS 'Sellers and helpers. Phone is encrypted with a blind index.';
COMMENT ON TABLE app.consent_records IS 'Versioned consent, append-only per purpose.';
COMMENT ON TABLE app.onboarding_state IS 'Persisted per conversation, resumable.';
COMMENT ON TABLE app.phone_change_requests IS 'Phone number change with cooling-off period.';
COMMENT ON TABLE app.helper_assignments IS 'Helper addition requires owner confirmation.';
COMMENT ON TABLE app.export_requests IS 'WhatsApp-confirmed data export with daily limit.';
COMMENT ON TABLE app.deletion_requests IS 'WhatsApp-confirmed account deletion with cooling-off.';
COMMENT ON TABLE app.feature_flags IS 'Per-shop feature flag overrides.';
