-- ================================================================
-- v4.6 — Включаем RLS на публичных таблицах
-- Аноним (publishable key) может ТОЛЬКО читать. Запись — через
-- service_role (воркер) и SECURITY DEFINER функции (обходят RLS).
-- ================================================================

ALTER TABLE domains     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crux_ranks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_log ENABLE ROW LEVEL SECURITY;

-- Чтение для всех (нужно фронту для отображения)
DROP POLICY IF EXISTS "public_read" ON domains;
CREATE POLICY "public_read" ON domains FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read" ON tasks;
CREATE POLICY "public_read" ON tasks FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read" ON crux_ranks;
CREATE POLICY "public_read" ON crux_ranks FOR SELECT USING (true);

-- entries / domain_list / process_log — старые таблицы, оставляем без политик
-- (полностью закрыты для anon)
