-- Сырьё по источникам отдельно + полные категории intel
ALTER TABLE domains ADD COLUMN IF NOT EXISTS categories jsonb;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS crux_raw jsonb;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS geo_raw jsonb;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS intel_raw jsonb;
