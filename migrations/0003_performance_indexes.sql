CREATE INDEX IF NOT EXISTS products_active_name_idx
  ON products (name)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS products_active_sku_idx
  ON products (sku)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS products_active_barcode_idx
  ON products (barcode)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS products_active_category_idx
  ON products (category_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS sales_status_created_at_idx
  ON sales (status, created_at DESC);

CREATE INDEX IF NOT EXISTS sales_cashier_status_created_at_idx
  ON sales (cashier_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS sales_register_created_at_idx
  ON sales (register_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS register_sessions_cashier_status_idx
  ON register_sessions (cashier_id, status);

CREATE INDEX IF NOT EXISTS audit_logs_user_created_at_idx
  ON audit_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS login_rate_limits_window_started_at_idx
  ON login_rate_limits (key_hash, window_started_at DESC);
