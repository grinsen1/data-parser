-- Добавление доменов к существующей задаче чанками (обход лимита 1000)
CREATE OR REPLACE FUNCTION add_batch_items(p_batch_id bigint, p_domains text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  d text;
BEGIN
  FOREACH d IN ARRAY p_domains LOOP
    INSERT INTO domains (domain) VALUES (lower(trim(d)))
      ON CONFLICT (domain) DO NOTHING;

    INSERT INTO batch_items (batch_id, domain) VALUES (p_batch_id, lower(trim(d)))
      ON CONFLICT DO NOTHING;

    INSERT INTO tasks (domain, kind) VALUES
      (lower(trim(d)), 'rank'),
      (lower(trim(d)), 'meta'),
      (lower(trim(d)), 'screenshot')
    ON CONFLICT (domain, kind) DO NOTHING;
  END LOOP;
END;
$$;
