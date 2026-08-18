-- Хранение ошибки сбора meta для отображения в UI
ALTER TABLE domains ADD COLUMN IF NOT EXISTS meta_error text;
