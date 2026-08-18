-- ================================================================
-- v4.2 — Задачи (батчи) + авторизация
-- batches = задача пользователя, batch_items = домены задачи
-- domains = глобальный кэш результатов (общий для всех)
-- ================================================================

-- 1. Профили пользователей (дополнение к auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz default now()
);

-- Автосоздание профиля при регистрации
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (new.id, new.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- 2. Задачи (батчи)
CREATE TABLE IF NOT EXISTS batches (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text default '',
  created_at timestamptz default now()
);

CREATE INDEX IF NOT EXISTS idx_batches_user ON batches (user_id, created_at desc);

-- 3. Домены внутри задачи
CREATE TABLE IF NOT EXISTS batch_items (
  batch_id  bigint not null references batches(id) on delete cascade,
  domain    text not null references domains(domain) on delete cascade,
  created_at timestamptz default now(),
  primary key (batch_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items (batch_id);

-- 4. Создание задачи из списка доменов (одним вызовом)
CREATE OR REPLACE FUNCTION create_batch(p_name text, p_domains text[])
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_batch_id bigint;
  d text;
BEGIN
  INSERT INTO batches (user_id, name) VALUES (auth.uid(), p_name)
    RETURNING id INTO v_batch_id;

  FOREACH d IN ARRAY p_domains LOOP
    INSERT INTO domains (domain) VALUES (lower(trim(d)))
      ON CONFLICT (domain) DO NOTHING;

    INSERT INTO batch_items (batch_id, domain) VALUES (v_batch_id, lower(trim(d)))
      ON CONFLICT DO NOTHING;

    -- задачи для воркера (rank/meta/screenshot)
    INSERT INTO tasks (domain, kind) VALUES
      (lower(trim(d)), 'rank'),
      (lower(trim(d)), 'meta'),
      (lower(trim(d)), 'screenshot')
    ON CONFLICT (domain, kind) DO NOTHING;
  END LOOP;

  RETURN v_batch_id;
END;
$$;

-- 5. Статус задачи: сколько доменов обработано по каждому типу
CREATE OR REPLACE FUNCTION batch_progress(p_batch_id bigint)
RETURNS TABLE(kind task_kind, state task_state, cnt bigint)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT t.kind, t.state, count(*)
  FROM tasks t
  JOIN batch_items bi ON bi.domain = t.domain
  WHERE bi.batch_id = p_batch_id
  GROUP BY t.kind, t.state
  ORDER BY t.kind, t.state;
$$;

-- ================================================================
-- RLS: пользователь видит только свои батчи
-- ================================================================
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own_batches" ON batches;
CREATE POLICY "own_batches" ON batches
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "own_batch_items" ON batch_items;
CREATE POLICY "own_batch_items" ON batch_items
  FOR ALL USING (
    EXISTS (SELECT 1 FROM batches b WHERE b.id = batch_id AND b.user_id = auth.uid())
  );

-- domains и tasks остаются общими (глобальный кэш), без RLS на чтение
-- profiles: каждый видит свой
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own_profile" ON profiles;
CREATE POLICY "own_profile" ON profiles
  FOR ALL USING (auth.uid() = id);
