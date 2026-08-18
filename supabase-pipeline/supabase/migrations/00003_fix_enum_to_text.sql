-- Фикс: все функции принимают text вместо enum (PostgREST не кастит строку в enum)

CREATE OR REPLACE FUNCTION claim_tasks(p_kind text, p_limit int, p_lease_sec int default 120)
RETURNS SETOF tasks LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE tasks t
     SET state = 'leased',
         lease_until = now() + make_interval(secs => p_lease_sec)
   WHERE t.id IN (
     SELECT id FROM tasks
      WHERE kind::text = p_kind AND state = 'pending' AND run_after <= now()
      ORDER BY run_after LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING t.*;
$$;

CREATE OR REPLACE FUNCTION complete_task(
  p_domain text,
  p_kind   text,
  p_state  text default 'done'
)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE tasks
     SET state = p_state::task_state,
         lease_until = null
   WHERE domain = lower(trim(p_domain)) AND kind::text = p_kind;
$$;

CREATE OR REPLACE FUNCTION fail_task(
  p_domain text,
  p_kind   text,
  p_error  text,
  p_max_attempts int default 3
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  t tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM tasks WHERE domain = lower(trim(p_domain)) AND kind::text = p_kind FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  t.attempts := t.attempts + 1;

  IF t.attempts >= p_max_attempts THEN
    t.level    := t.level + 1;
    t.attempts := 0;
  END IF;

  IF t.level > 4 THEN
    t.state := 'dead';
  ELSE
    t.state := 'pending';
    t.run_after := now() + make_interval(secs => floor(random() * least(60, power(2, t.attempts + 1)))::int);
  END IF;

  t.last_error := p_error;
  t.lease_until := null;

  UPDATE tasks SET
    state = t.state, level = t.level, attempts = t.attempts,
    run_after = t.run_after, last_error = t.last_error, lease_until = null
  WHERE domain = t.domain AND kind = t.kind;
END;
$$;
