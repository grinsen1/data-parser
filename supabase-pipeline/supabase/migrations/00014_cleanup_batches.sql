-- ================================================================
-- v4.5 — Автоудаление старых batch (28 дней)
-- Удаляет только batches + batch_items (cascade). domains (глобальный
-- кэш) и tasks (очередь) остаются.
-- ================================================================

CREATE OR REPLACE FUNCTION cleanup_old_batches()
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM batches WHERE created_at < now() - interval '28 days';
$$;

-- Раз в сутки в 04:00
SELECT cron.schedule('cleanup-batches', '0 4 * * *', $$ SELECT cleanup_old_batches(); $$);
