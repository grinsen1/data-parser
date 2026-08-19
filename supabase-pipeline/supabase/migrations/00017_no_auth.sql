-- ================================================================
-- v4.7 — Откат авторизации: работаем без JWT (прокси режет /auth/v1/*)
-- batches/batch_items: public_read вместо own_*
-- create_batch: без auth.uid()
-- ================================================================

ALTER TABLE batches ALTER COLUMN user_id DROP NOT NULL;

DROP POLICY IF EXISTS "own_batches" ON batches;
DROP POLICY IF EXISTS "public_read" ON batches;
CREATE POLICY "public_read" ON batches FOR SELECT USING (true);

DROP POLICY IF EXISTS "own_batch_items" ON batch_items;
DROP POLICY IF EXISTS "public_read" ON batch_items;
CREATE POLICY "public_read" ON batch_items FOR SELECT USING (true);

-- create_batch без auth.uid() (user_id теперь nullable)
CREATE OR REPLACE FUNCTION create_batch(p_name text, p_domains text[])
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_batch_id bigint;
  d text;
BEGIN
  INSERT INTO batches (name) VALUES (p_name)
    RETURNING id INTO v_batch_id;

  FOREACH d IN ARRAY p_domains LOOP
    INSERT INTO domains (domain) VALUES (lower(trim(d)))
      ON CONFLICT (domain) DO NOTHING;
    INSERT INTO batch_items (batch_id, domain) VALUES (v_batch_id, lower(trim(d)))
      ON CONFLICT DO NOTHING;
    INSERT INTO tasks (domain, kind) VALUES
      (lower(trim(d)), 'rank'), (lower(trim(d)), 'meta'), (lower(trim(d)), 'screenshot'),
      (lower(trim(d)), 'crux'), (lower(trim(d)), 'geo'), (lower(trim(d)), 'intel')
    ON CONFLICT (domain, kind) DO NOTHING;
  END LOOP;

  RETURN v_batch_id;
END;
$$;
