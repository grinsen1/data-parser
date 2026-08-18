-- Крон для новых типов задач (первый запуск, unschedule не нужен)
-- crux: CrUX API лимит 150/мин, каждый домен до 4 запросов (перебор origin) → консервативно 10/мин
-- geo: Cloudflare Radar → 20/мин
-- intel: bulk, одна пачка → 100/мин

SELECT cron.schedule('worker-crux',  '*/1 * * * *', $$ SELECT run_worker('crux', 10); $$);
SELECT cron.schedule('worker-geo',   '*/1 * * * *', $$ SELECT run_worker('geo', 20); $$);
SELECT cron.schedule('worker-intel', '*/1 * * * *', $$ SELECT run_worker('intel', 100); $$);
