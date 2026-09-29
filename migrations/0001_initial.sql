CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'CASHIER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE login_rate_limits (
  key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  selling_price NUMERIC(12, 2) NOT NULL CHECK (selling_price >= 0),
  cost_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_name_search_idx ON products USING GIN (to_tsvector('simple', name));
CREATE INDEX products_category_id_idx ON products(category_id);
CREATE INDEX products_low_stock_idx ON products(stock_quantity, low_stock_threshold)
  WHERE status = 'ACTIVE';

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_phone_idx ON customers(phone);

CREATE TABLE register_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cashier_id UUID NOT NULL REFERENCES users(id),
  opening_balance NUMERIC(12, 2) NOT NULL CHECK (opening_balance >= 0),
  closing_balance NUMERIC(12, 2) CHECK (closing_balance >= 0),
  expected_closing_balance NUMERIC(12, 2),
  variance NUMERIC(12, 2),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'))
);
CREATE UNIQUE INDEX register_one_open_per_cashier_idx ON register_sessions(cashier_id)
  WHERE status = 'OPEN';
CREATE INDEX register_sessions_opened_at_idx ON register_sessions(opened_at DESC);

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key UUID NOT NULL UNIQUE,
  idempotency_hash TEXT NOT NULL,
  receipt_number TEXT NOT NULL UNIQUE,
  cashier_id UUID NOT NULL REFERENCES users(id),
  register_session_id UUID NOT NULL REFERENCES register_sessions(id),
  subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
  amount_paid NUMERIC(12, 2) NOT NULL CHECK (amount_paid >= total),
  change_due NUMERIC(12, 2) NOT NULL CHECK (change_due >= 0),
  payment_method TEXT NOT NULL DEFAULT 'CASH' CHECK (payment_method = 'CASH'),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'VOIDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sales_created_at_idx ON sales(created_at DESC);
CREATE INDEX sales_cashier_created_at_idx ON sales(cashier_id, created_at DESC);

CREATE TABLE sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id),
  product_id UUID NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0)
);
CREATE INDEX sale_items_sale_id_idx ON sale_items(sale_id);
CREATE INDEX sale_items_product_id_idx ON sale_items(product_id);

CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('SALE', 'RESTOCK', 'ADJUSTMENT', 'VOID')),
  reference_id UUID,
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_created_idx ON stock_movements(product_id, created_at DESC);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  description TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_by UUID NOT NULL REFERENCES users(id),
  register_session_id UUID REFERENCES register_sessions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX expenses_created_at_idx ON expenses(created_at DESC);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at DESC);