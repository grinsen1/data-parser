-- Оптимизация: bulk-вставка вместо цикла FOREACH
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
  CROSS JOIN (VALUES ('rank'::task_kind), ('meta'::task_kind), ('screenshot'::task_kind)) AS kinds(k)
  ON CONFLICT (domain, kind) DO NOTHING;
END;
$$;
