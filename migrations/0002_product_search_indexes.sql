CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS products_active_name_trgm_idx
  ON products USING GIN (name gin_trgm_ops)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS products_active_sku_trgm_idx
  ON products USING GIN (sku gin_trgm_ops)
  WHERE status = 'ACTIVE';