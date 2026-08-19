-- ================================================================
-- v4.8 — Серверные снапшоты готовых таблиц/списков в R2
-- list_done_batches(): задачи без pending/leased и со свежим done_at
-- run_snapshot(): триггерит Edge Function (action=snapshot)
-- ================================================================

ALTER TABLE batches ADD COLUMN IF NOT EXISTS snapshotted_at timestamptz;

-- Готовые задачи, которые нужно (пере)снапшотить
CREATE OR REPLACE FUNCTION list_done_batches()
RETURNS TABLE(batch_id bigint) LANGUAGE sql AS $$
  WITH batch_latest AS (
    SELECT bi.batch_id, max(t.done_at) AS last_done
    FROM batch_items bi
    JOIN tasks t ON t.domain = bi.domain
    GROUP BY bi.batch_id
  ),
  has_pending AS (
    SELECT DISTINCT bi.batch_id
    FROM batch_items bi
    JOIN tasks t ON t.domain = bi.domain AND t.state IN ('pending','leased')
  )
  SELECT bl.batch_id
  FROM batch_latest bl
  LEFT JOIN has_pending hp ON hp.batch_id = bl.batch_id
  LEFT JOIN batches b ON b.id = bl.batch_id
  WHERE hp.batch_id IS NULL
    AND (b.snapshotted_at IS NULL OR b.snapshotted_at < bl.last_done);
$$;

-- Триггер Edge Function (action=snapshot) через pg_net
CREATE OR REPLACE FUNCTION run_snapshot()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://dcrmfvfuyexjdygbupwr.supabase.co/functions/v1/workr',
    body := json_build_object('action', 'snapshot')::jsonb,
    headers := json_build_object('Content-Type', 'application/json')::jsonb
  );
END;
$$;

SELECT cron.schedule('snapshot-batches', '*/3 * * * *', $$ SELECT run_snapshot(); $$);
