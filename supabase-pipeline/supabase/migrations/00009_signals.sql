-- ================================================================
-- v4.3 — Досбор сигналов: CrUX (поведение+тех) + Cloudflare (гео+категория)
-- ================================================================

-- 1. Новые значения task_kind
DO $$ BEGIN
  ALTER TYPE task_kind ADD VALUE 'crux';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE task_kind ADD VALUE 'geo';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE task_kind ADD VALUE 'intel';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Новые колонки в domains
ALTER TABLE domains ADD COLUMN IF NOT EXISTS lcp_p75 int;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS inp_p75 int;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS cls_p75 numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS reload numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS bf_sum numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS navigate numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS prerender numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS phone numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS crux_variant text;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS ru_share numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS ru_rank int;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS top_country text;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS foreign_tail numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS geo_verdict text;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS super_category text;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS raw jsonb;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS checked_at timestamptz;

-- 3. add_batch_items: теперь 6 задач на домен
CREATE OR REPLACE FUNCTION add_batch_items(p_batch_id bigint, p_domains text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO domains (domain)
  SELECT lower(trim(d)) FROM unnest(p_domains) AS d
  ON CONFLICT (domain) DO NOTHING;

  INSERT INTO batch_items (batch_id, domain)
  SELECT p_batch_id, lower(trim(d)) FROM unnest(p_domains) AS d
  ON CONFLICT DO NOTHING;

  INSERT INTO tasks (domain, kind)
  SELECT lower(trim(d)), k
  FROM unnest(p_domains) AS d
  CROSS JOIN (VALUES
    ('rank'::task_kind), ('meta'::task_kind), ('screenshot'::task_kind),
    ('crux'::task_kind), ('geo'::task_kind), ('intel'::task_kind)
  ) AS kinds(k)
  ON CONFLICT (domain, kind) DO NOTHING;
END;
$$;

-- 4. register_domains (для совместимости) — тоже 6 задач
CREATE OR REPLACE FUNCTION register_domains(p_domains text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  d text;
BEGIN
  FOREACH d IN ARRAY p_domains LOOP
    INSERT INTO domains (domain) VALUES (lower(trim(d)))
      ON CONFLICT (domain) DO NOTHING;

    INSERT INTO tasks (domain, kind) VALUES
      (lower(trim(d)), 'rank'),
      (lower(trim(d)), 'meta'),
      (lower(trim(d)), 'screenshot'),
      (lower(trim(d)), 'crux'),
      (lower(trim(d)), 'geo'),
      (lower(trim(d)), 'intel')
    ON CONFLICT (domain, kind) DO NOTHING;
  END LOOP;
END;
$$;
