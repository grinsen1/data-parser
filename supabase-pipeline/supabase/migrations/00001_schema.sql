-- ================================================================
-- Universal Parser v4 — Supabase Migration
-- Замена parser.ps1 / database.xlsx
-- ================================================================

-- 1. Основная таблица записей (аналог database.xlsx)
CREATE TABLE IF NOT EXISTS entries (
  id                TEXT PRIMARY KEY,      -- домен / package / app store id
  name              TEXT DEFAULT '',
  description       TEXT DEFAULT '',
  installs          TEXT DEFAULT '',       -- визиты или установки
  category          TEXT DEFAULT '',
  entry_type        TEXT DEFAULT 'unknown', -- website / googleplay / appstore
  rating            TEXT DEFAULT '',
  screenshot_url    TEXT DEFAULT '',       -- URL в Supabase Storage
  downloads_monthly TEXT DEFAULT '',
  top_countries     TEXT DEFAULT '',
  revenue_monthly   TEXT DEFAULT '',
  last_updated      TIMESTAMPTZ DEFAULT now(),
  
  -- HTTP-коды ответов API
  web_response_code     TEXT DEFAULT '',
  googleplay_response_code TEXT DEFAULT '',
  appstore_response_code  TEXT DEFAULT '',
  
  -- CrUX метрики
  crux_present       BOOLEAN DEFAULT false,
  crux_rank_global   INTEGER,
  crux_rank_ru       INTEGER,
  crux_tier          TEXT DEFAULT 'E',     -- A/B/C/D/E
  crux_lcp           NUMERIC,             -- ms
  crux_inp           NUMERIC,             -- ms
  crux_cls           NUMERIC,             -- 0-1
  crux_has_desktop   BOOLEAN,
  crux_has_mobile    BOOLEAN,
  
  -- Оценка качества
  quality_score      INTEGER DEFAULT 0,   -- 0-10
  quality_label      TEXT DEFAULT 'unproven',
  
  -- Управление
  to_remove          BOOLEAN DEFAULT false,
  remove_reason      TEXT DEFAULT '',
  enabled            BOOLEAN DEFAULT true
);

-- 2. Справочник рангов CrUX (загружается из crux-top-lists раз в месяц)
CREATE TABLE IF NOT EXISTS crux_ranks (
  domain       TEXT NOT NULL,
  scope        TEXT NOT NULL,              -- 'global' | 'ru'
  rank         INTEGER NOT NULL,
  updated_at   DATE DEFAULT CURRENT_DATE,
  PRIMARY KEY (domain, scope)
);

CREATE INDEX IF NOT EXISTS idx_crux_ranks_domain ON crux_ranks(domain);
CREATE INDEX IF NOT EXISTS idx_crux_ranks_scope_rank ON crux_ranks(scope, rank);

-- 3. Список доменов для обработки (аналог domains.txt)
CREATE TABLE IF NOT EXISTS domain_list (
  domain    TEXT PRIMARY KEY,
  added_at  TIMESTAMPTZ DEFAULT now(),
  active    BOOLEAN DEFAULT true,
  notes     TEXT DEFAULT ''
);

-- 4. Лог обработки
CREATE TABLE IF NOT EXISTS process_log (
  id          SERIAL PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES entries(id),
  status      TEXT NOT NULL,             -- ok / error / skipped / not_found
  source      TEXT NOT NULL,             -- digitalbudget / crux / apptally / itunes
  message     TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 5. Функция: получить записи, требующие обновления
CREATE OR REPLACE FUNCTION get_stale_entries(days_threshold INT DEFAULT 30)
RETURNS SETOF entries AS $$
BEGIN
  RETURN QUERY
    SELECT * FROM entries
    WHERE enabled = true
      AND (
        last_updated IS NULL
        OR last_updated < now() - (days_threshold || ' days')::INTERVAL
        OR installs IS NULL OR installs = '' OR installs = '0'
        OR web_response_code IN ('407','429','403','000','')
        OR googleplay_response_code IN ('407','429','403','000','')
        OR appstore_response_code IN ('407','429','403','000','')
      )
    ORDER BY 
      CASE crux_tier
        WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3
        WHEN 'D' THEN 4 WHEN 'E' THEN 5 ELSE 6
      END,
      domain;
END;
$$ LANGUAGE plpgsql;

-- 6. Функция: upsert записи (логика Add-ToDatabase из parser.ps1)
CREATE OR REPLACE FUNCTION upsert_entry(data JSONB)
RETURNS void AS $$
BEGIN
  INSERT INTO entries (
    id, name, description, installs, category, entry_type,
    rating, screenshot_url, downloads_monthly, top_countries, revenue_monthly,
    last_updated,
    web_response_code, googleplay_response_code, appstore_response_code,
    crux_present, crux_rank_global, crux_rank_ru, crux_tier,
    crux_lcp, crux_inp, crux_cls, crux_has_desktop, crux_has_mobile,
    quality_score, quality_label, to_remove, remove_reason
  ) VALUES (
    data->>'id',
    data->>'name',
    data->>'description',
    data->>'installs',
    data->>'category',
    data->>'entry_type',
    data->>'rating',
    data->>'screenshot_url',
    data->>'downloads_monthly',
    data->>'top_countries',
    data->>'revenue_monthly',
    COALESCE((data->>'last_updated')::TIMESTAMPTZ, now()),
    data->>'web_response_code',
    data->>'googleplay_response_code',
    data->>'appstore_response_code',
    (data->>'crux_present')::BOOLEAN,
    (data->>'crux_rank_global')::INTEGER,
    (data->>'crux_rank_ru')::INTEGER,
    data->>'crux_tier',
    (data->>'crux_lcp')::NUMERIC,
    (data->>'crux_inp')::NUMERIC,
    (data->>'crux_cls')::NUMERIC,
    (data->>'crux_has_desktop')::BOOLEAN,
    (data->>'crux_has_mobile')::BOOLEAN,
    (data->>'quality_score')::INTEGER,
    data->>'quality_label',
    (data->>'to_remove')::BOOLEAN,
    data->>'remove_reason'
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    installs = EXCLUDED.installs,
    category = EXCLUDED.category,
    entry_type = EXCLUDED.entry_type,
    rating = EXCLUDED.rating,
    screenshot_url = EXCLUDED.screenshot_url,
    downloads_monthly = EXCLUDED.downloads_monthly,
    top_countries = EXCLUDED.top_countries,
    revenue_monthly = EXCLUDED.revenue_monthly,
    last_updated = EXCLUDED.last_updated,
    web_response_code = EXCLUDED.web_response_code,
    googleplay_response_code = EXCLUDED.googleplay_response_code,
    appstore_response_code = EXCLUDED.appstore_response_code,
    crux_present = EXCLUDED.crux_present,
    crux_rank_global = EXCLUDED.crux_rank_global,
    crux_rank_ru = EXCLUDED.crux_rank_ru,
    crux_tier = EXCLUDED.crux_tier,
    crux_lcp = EXCLUDED.crux_lcp,
    crux_inp = EXCLUDED.crux_inp,
    crux_cls = EXCLUDED.crux_cls,
    crux_has_desktop = EXCLUDED.crux_has_desktop,
    crux_has_mobile = EXCLUDED.crux_has_mobile,
    quality_score = EXCLUDED.quality_score,
    quality_label = EXCLUDED.quality_label,
    to_remove = EXCLUDED.to_remove,
    remove_reason = EXCLUDED.remove_reason;
END;
$$ LANGUAGE plpgsql;

-- 7. Включаем pg_cron и планировщик
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Ежедневный запуск в 03:00 MSK
SELECT cron.schedule(
  'process-entries-daily',
  '0 3 * * *',
  $$SELECT net.http_post(
    url := 'https://' || current_setting('app.settings.project_ref') || '.supabase.co/functions/v1/process-entries',
    headers := '{"Authorization": "Bearer ' || current_setting('app.settings.service_role_key') || '"}'::jsonb,
    body := '{"limit": 50}'::jsonb
  ) AS request_id$$
);
