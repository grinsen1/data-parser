-- ================================================================
-- Тюнинг под 1000 доменов (3000 задач)
-- rank/screenshot быстрые → большой limit
-- meta медленная → маленький limit
-- ================================================================

-- 1. run_worker принимает limit параметром
CREATE OR REPLACE FUNCTION run_worker(p_kind text, p_limit int default 10)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://dcrmfvfuyexjdygbupwr.supabase.co/functions/v1/workr',
    body := json_build_object('kind', p_kind, 'limit', p_limit)::jsonb,
    headers := json_build_object('Content-Type', 'application/json')::jsonb
  );
END;
$$;

-- 2. Удаляем старые кроны
SELECT cron.unschedule('worker-rank');
SELECT cron.unschedule('worker-meta');
SELECT cron.unschedule('worker-screenshot');

-- 3. Новые кроны с разными лимитами
-- rank: 50 задач/мин (чистый DB lookup)
SELECT cron.schedule('worker-rank', '*/1 * * * *', $$ SELECT run_worker('rank', 50); $$);

-- meta: 10 задач/мин (fetch + парсинг, осторожно с CPU)
SELECT cron.schedule('worker-meta', '*/1 * * * *', $$ SELECT run_worker('meta', 10); $$);

-- screenshot: 50 задач/мин (просто пишет thum.io URL)
SELECT cron.schedule('worker-screenshot', '*/1 * * * *', $$ SELECT run_worker('screenshot', 50); $$);
