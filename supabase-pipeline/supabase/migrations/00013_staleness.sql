-- ================================================================
-- v4.4 — Дособирание по необходимости (свежесть кэша в момент новой задачи)
-- done_at фиксирует, когда задача завершена. add_batch_items сбрасывает
-- устаревшие done → pending, свежие остаются в кэше.
-- ================================================================

-- 1. Время завершения задачи
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS done_at timestamptz;

-- 2. complete_task фиксирует done_at
CREATE OR REPLACE FUNCTION complete_task(
  p_domain text,
  p_kind   text,
  p_state  text default 'done'
)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE tasks
     SET state = p_state::task_state,
         lease_until = null,
         done_at = now()
   WHERE domain = lower(trim(p_domain)) AND kind::text = p_kind;
$$;

-- 3. add_batch_items: вставка + сброс устаревших done → pending
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

  -- Сброс устаревших: только устаревшие done идут в pending (дотягиваются),
  -- свежие остаются в кэше (done, воркер их не трогает)
  UPDATE tasks t
     SET state = 'pending', run_after = now(), done_at = null
   FROM unnest(p_domains) AS d
  WHERE t.domain = lower(trim(d))
    AND t.state = 'done'
    AND t.done_at IS NOT NULL
    AND t.done_at < now() - (
      CASE t.kind::text
        WHEN 'crux' THEN interval '30 days'
        WHEN 'geo'  THEN interval '30 days'
        WHEN 'rank' THEN interval '30 days'
        ELSE interval '90 days'
      END
    );
END;
$$;
