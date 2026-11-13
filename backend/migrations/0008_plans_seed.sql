-- 0008_plans_seed.sql
--
-- Seed the default plan. Presets are loaded by scripts/seed-presets.ts from JSON
-- data files, not by migration (they are reference data, not schema).

INSERT INTO app.plans (plan_key, name, trial_days, features, version)
VALUES
  ('FREE', 'Free', 14, '{"max_entries_per_month": 100, "max_customers": 50, "export": false, "reminders": true, "voice": true}'::jsonb, 1),
  ('STARTER', 'Starter', 14, '{"max_entries_per_month": 500, "max_customers": 200, "export": true, "reminders": true, "voice": true}'::jsonb, 1),
  ('PRO', 'Pro', 14, '{"max_entries_per_month": 5000, "max_customers": 2000, "export": true, "reminders": true, "voice": true}'::jsonb, 1)
ON CONFLICT (plan_key) DO UPDATE
  SET name = EXCLUDED.name,
      trial_days = EXCLUDED.trial_days,
      features = EXCLUDED.features,
      version = EXCLUDED.version,
      updated_at = now();
