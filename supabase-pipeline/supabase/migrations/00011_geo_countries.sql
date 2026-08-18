-- Полный список стран гео для модального окна
ALTER TABLE domains ADD COLUMN IF NOT EXISTS geo_countries jsonb;
