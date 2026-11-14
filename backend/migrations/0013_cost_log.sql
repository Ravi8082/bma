-- 0013_cost_log.sql
--
-- Phase 4: per-call cost tracking for LLM and STT. Append-only, FORCE RLS.
--
CREATE TABLE IF NOT EXISTS app.cost_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  provider          text NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 40),
  model             text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 80),
  kind              text NOT NULL CHECK (kind IN ('LLM','STT')),
  outcome           text NOT NULL CHECK (outcome IN ('SUCCESS','FAILED','FALLBACK')),
  prompt_tokens     integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  voice_minutes     numeric(8,3) NOT NULL DEFAULT 0 CHECK (voice_minutes >= 0),
  cost_paise        bigint NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_cost_log_shop_occurred ON app.cost_log (shop_id, occurred_at DESC);

ALTER TABLE app.cost_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cost_log FORCE ROW LEVEL SECURITY;

CREATE POLICY cost_log_tenant_isolation ON app.cost_log
  USING (shop_id = current_setting('app.shop_id', true)::uuid)
  WITH CHECK (shop_id = current_setting('app.shop_id', true)::uuid);

GRANT SELECT, INSERT ON app.cost_log TO bma_app;
GRANT SELECT ON app.cost_log TO bma_reporting;
GRANT SELECT, INSERT ON app.cost_log TO bma_migrator;
