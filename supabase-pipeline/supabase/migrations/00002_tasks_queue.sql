-- ================================================================
-- v4.1 — Миграция на серверную очередь задач
-- domains (результаты) + tasks (журнал работы с арендой)
-- ================================================================

-- 1. Результаты — растут только вперёд, перезапуск не теряет данные
CREATE TABLE IF NOT EXISTS domains (
  domain            text primary key,
  rank              int,
  rank_source       text,               -- 'crux_ranks' | 'crux_api'
  title             text,
  description       text,
  screenshot_path   text,
  screenshot_source text,               -- 'thumio' | 'pagespeed' | 'storage'
  updated_at        timestamptz default now()
);

-- 2. Типы задач и состояния
DO $$ BEGIN
  CREATE TYPE task_kind  AS ENUM ('rank','meta','screenshot');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_state AS ENUM ('pending','leased','done','no_data','dead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Журнал работы: строка на пару (домен, тип задачи)
CREATE TABLE IF NOT EXISTS tasks (
  id            bigint generated always as identity primary key,
  domain        text not null references domains(domain) on delete cascade,
  kind          task_kind not null,
  state         task_state not null default 'pending',
  level         smallint  not null default 1,       -- текущий уровень фолбэка
  attempts      smallint  not null default 0,       -- попытки на этом уровне
  lease_until   timestamptz,                        -- аренда, а не флаг «занято»
  run_after     timestamptz not null default now(), -- бэкофф
  last_error    text,
  unique (domain, kind)
);

CREATE INDEX IF NOT EXISTS idx_tasks_pending ON tasks (kind, run_after) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_leased  ON tasks (lease_until)     WHERE state = 'leased';

-- 4. Атомарная аренда задач (защита от гонок через SKIP LOCKED)
CREATE OR REPLACE FUNCTION claim_tasks(p_kind task_kind, p_limit int, p_lease_sec int default 120)
RETURNS SETOF tasks LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE tasks t
     SET state = 'leased',
         lease_until = now() + make_interval(secs => p_lease_sec)
   WHERE t.id IN (
     SELECT id FROM tasks
      WHERE kind = p_kind AND state = 'pending' AND run_after <= now()
      ORDER BY run_after LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING t.*;
$$;

-- 5. «Жнец»: возвращает протухшие аренды в работу (автовосстановление)
CREATE OR REPLACE FUNCTION reap_expired_leases()
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE tasks
     SET state = 'pending', run_after = now()
   WHERE state = 'leased' AND lease_until < now();
$$;

-- 6. Регистрация домена: создаёт записи в domains + tasks одним вызовом
CREATE OR REPLACE FUNCTION register_domains(p_domains text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  d text;
BEGIN
  FOREACH d IN ARRAY p_domains LOOP
    INSERT INTO domains (domain) VALUES (lower(trim(d)))
      ON CONFLICT (domain) DO NOTHING;

    INSERT INTO tasks (domain, kind) VALUES
      (lower(trim(d)), 'rank'),
      (lower(trim(d)), 'meta'),
      (lower(trim(d)), 'screenshot')
    ON CONFLICT (domain, kind) DO NOTHING;
  END LOOP;
END;
$$;

-- 7. Отметить задачу выполненной (идемпотентно)
CREATE OR REPLACE FUNCTION complete_task(
  p_domain text,
  p_kind   task_kind,
  p_state  task_state default 'done'
)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE tasks
     SET state = p_state,
         lease_until = null
   WHERE domain = lower(trim(p_domain)) AND kind = p_kind;
$$;

-- 8. Провалить попытку: бэкофф с full jitter, подъём уровня при исчерпании
CREATE OR REPLACE FUNCTION fail_task(
  p_domain text,
  p_kind   task_kind,
  p_error  text,
  p_max_attempts int default 3
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  t tasks%ROWTYPE;
  backoff interval;
BEGIN
  SELECT * INTO t FROM tasks WHERE domain = lower(trim(p_domain)) AND kind = p_kind FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  t.attempts := t.attempts + 1;

  IF t.attempts >= p_max_attempts THEN
    -- исчерпали уровень → следующий, сброс попыток
    t.level    := t.level + 1;
    t.attempts := 0;
  END IF;

  IF t.level > 4 OR (SELECT count(*) FROM tasks WHERE domain = t.domain AND attempts >= 6) > 0 THEN
    t.state := 'dead';
  ELSE
    -- full jitter: random(0, min(60, 2^attempts))
    t.state := 'pending';
    t.run_after := now() + make_interval(secs => floor(random() * least(60, power(2, t.attempts))))::int;
  END IF;

  t.last_error := p_error;
  t.lease_until := null;

  UPDATE tasks SET
    state = t.state, level = t.level, attempts = t.attempts,
    run_after = t.run_after, last_error = t.last_error, lease_until = null
  WHERE domain = t.domain AND kind = t.kind;
END;
$$;

-- 9. «Оживить мёртвых»: кнопка в UI
CREATE OR REPLACE FUNCTION revive_dead_tasks()
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE tasks SET state='pending', level=1, attempts=0, run_after=now()
   WHERE state='dead';
$$;

-- 10. Прогресс для UI: счётчики по состояниям
CREATE OR REPLACE FUNCTION tasks_progress()
RETURNS TABLE(kind task_kind, state task_state, cnt bigint)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT kind, state, count(*) FROM tasks GROUP BY kind, state ORDER BY kind, state;
$$;
