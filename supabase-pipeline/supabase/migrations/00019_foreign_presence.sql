-- ================================================================
-- v4.9 — Иностранный след .ru-доменов (CrUX страновые топы)
-- foreign_presence: (domain, country, bucket) — в каких неевропейских/
-- не-СНГ топах светится домен. domains.foreign — агрегат для фронта.
-- ================================================================

CREATE TABLE IF NOT EXISTS foreign_presence (
  domain     text NOT NULL,
  country    text NOT NULL,
  bucket     int  NOT NULL,
  updated_at date NOT NULL DEFAULT current_date,
  PRIMARY KEY (domain, country)
);

ALTER TABLE domains ADD COLUMN IF NOT EXISTS foreign_trace jsonb;

ALTER TABLE foreign_presence ENABLE ROW LEVEL SECURITY;
