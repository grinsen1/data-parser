-- ================================================================
-- pg_cron: автозапуск воркера каждую минуту
-- Воркер дёргается по HTTP (Edge Function), verify_jwt=false
-- ================================================================

-- 1. Включаем pg_net (для HTTP-запросов из Postgres)
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Функция запуска воркера по типу задачи
CREATE OR REPLACE FUNCTION run_worker(p_kind text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://dcrmfvfuyexjdygbupwr.supabase.co/functions/v1/workr',
    body := json_build_object('kind', p_kind, 'limit', 10)::jsonb,
    headers := json_build_object('Content-Type', 'application/json')::jsonb
  );
END;
$$;

-- 3. Крон-задачи: каждую минуту, со сдвигом в 20 сек чтобы не толкаться
SELECT cron.schedule('worker-rank',       '*/1 * * * *', $$ SELECT run_worker('rank'); $$);
SELECT cron.schedule('worker-meta',       '*/1 * * * *', $$ SELECT run_worker('meta'); $$);
SELECT cron.schedule('worker-screenshot', '*/1 * * * *', $$ SELECT run_worker('screenshot'); $$);

-- 4. Жнец протухших аренд — раз в минуту
SELECT cron.schedule('reap-leases', '*/1 * * * *', $$ SELECT reap_expired_leases(); $$);
