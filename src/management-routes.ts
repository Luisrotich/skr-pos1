import { Hono } from 'hono';
import type { AppVariables, Env } from './db';
import { hashPassword, requireAuth, requireRole } from './security';

const routes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
routes.use('*', requireAuth);

routes.get('/dashboard', requireRole('ADMIN'), async (context) => {
  const result = await context.get('db').query(`
    SELECT
      (SELECT COALESCE(SUM(total), 0) FROM sales WHERE status = 'COMPLETED' AND created_at >= date_trunc('day', now())) AS today_sales,
      (SELECT COUNT(*) FROM sales WHERE status = 'COMPLETED' AND created_at >= date_trunc('day', now())) AS transactions,
      (SELECT COUNT(*) FROM products WHERE status = 'ACTIVE') AS products,
      (SELECT COUNT(*) FROM products WHERE status = 'ACTIVE' AND stock_quantity <= low_stock_threshold) AS low_stock,
      (SELECT COUNT(*) FROM users WHERE status = 'ACTIVE' AND role = 'CASHIER') AS active_cashiers,
      (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE created_at >= date_trunc('day', now())) AS today_expenses,
      (SELECT COALESCE(SUM(si.subtotal - (si.quantity * si.unit_cost)), 0)
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.status = 'COMPLETED' AND s.created_at >= date_trunc('day', now())) AS today_profit
  `);
  const recent = await context.get('db').query(`
    SELECT s.id, s.receipt_number, s.total, s.created_at, u.name AS cashier_name
    FROM sales s JOIN users u ON u.id = s.cashier_id
    ORDER BY s.created_at DESC LIMIT 8
  `);
  return context.json({ summary: result.rows[0], recentSales: recent.rows });
});

routes.get('/users', requireRole('ADMIN'), async (context) => {
  const users = await context.get('db').query(
    "SELECT id, name, username, role, status, created_at FROM users ORDER BY created_at DESC LIMIT 200",
  );
  return context.json({ users: users.rows });
});

routes.post('/users', requireRole('ADMIN'), async (context) => {
  const body = await context.req.json().catch(() => null) as { name?: unknown; username?: unknown; password?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (name.length < 2 || name.length > 100 || !/^[a-z0-9._-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) {
    return context.json({ error: 'Provide valid cashier details and a password of at least 12 characters.' }, 400);
  }
  const result = await context.get('db').query(
    "INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, 'CASHIER') RETURNING id, name, username, role, status",
    [name, username, await hashPassword(password)],
  );
  await context.get('db').query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'CASHIER_CREATED', 'user', $2)",
    [context.get('user').id, result.rows[0].id],
  );
  return context.json({ user: result.rows[0] }, 201);
});

routes.put('/users/:id', requireRole('ADMIN'), async (context) => {
  const body = await context.req.json().catch(() => null) as { name?: unknown; status?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const status = body?.status;
  if (name.length < 2 || name.length > 100 || !['ACTIVE', 'INACTIVE'].includes(String(status))) {
    return context.json({ error: 'Provide a valid name and status.' }, 400);
  }
  const result = await context.get('db').query(
    "UPDATE users SET name = $1, status = $2, updated_at = now() WHERE id = $3 AND role = 'CASHIER' RETURNING id, name, username, role, status",
    [name, status, context.req.param('id')],
  );
  if (!result.rowCount) return context.json({ error: 'Cashier not found.' }, 404);
  await context.get('db').query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'CASHIER_UPDATED', 'user', $2)",
    [context.get('user').id, context.req.param('id')],
  );
  return context.json({ user: result.rows[0] });
});

routes.put('/users/:id/password', requireRole('ADMIN'), async (context) => {
  const body = await context.req.json().catch(() => null) as { password?: unknown } | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length < 12 || password.length > 256) return context.json({ error: 'Password must be at least 12 characters.' }, 400);
  const result = await context.get('db').query(
    "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 AND role = 'CASHIER' RETURNING id",
    [await hashPassword(password), context.req.param('id')],
  );
  if (!result.rowCount) return context.json({ error: 'Cashier not found.' }, 404);
  await context.get('db').query('DELETE FROM sessions WHERE user_id = $1', [context.req.param('id')]);
  await context.get('db').query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'CASHIER_PASSWORD_RESET', 'user', $2)",
    [context.get('user').id, context.req.param('id')],
  );
  return context.json({ reset: true });
});

routes.get('/inventory', async (context) => {
  const limit = Math.min(Math.max(Number(context.req.query('limit')) || 100, 1), 500);
  const result = await context.get('db').query(
    `SELECT p.id, p.name, p.sku, p.stock_quantity, p.low_stock_threshold, p.cost_price, p.selling_price,
            (p.stock_quantity <= p.low_stock_threshold) AS low_stock
     FROM products p WHERE p.status = 'ACTIVE' ORDER BY low_stock DESC, p.name LIMIT $1`,
    [limit],
  );
  return context.json({ inventory: result.rows });
});

routes.post('/inventory/adjust', requireRole('ADMIN'), async (context) => {
  const body = await context.req.json().catch(() => null) as { productId?: unknown; quantity?: unknown; reason?: unknown } | null;
  const productId = typeof body?.productId === 'string' ? body.productId : '';
  const quantity = Number(body?.quantity);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(productId) || !Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > 100_000 || !reason || reason.length > 250) {
    return context.json({ error: 'Provide a product, non-zero quantity adjustment, and reason.' }, 400);
  }
  const db = context.get('db');
  await db.query('BEGIN');
  try {
    const product = await db.query(
      "UPDATE products SET stock_quantity = stock_quantity + $1, updated_at = now() WHERE id = $2 AND status = 'ACTIVE' AND stock_quantity + $1 >= 0 RETURNING id, stock_quantity",
      [quantity, productId],
    );
    if (!product.rowCount) {
      await db.query('ROLLBACK');
      return context.json({ error: 'Product not found or adjustment would make stock negative.' }, 409);
    }
    await db.query(
      "INSERT INTO stock_movements (product_id, quantity, movement_type, user_id) VALUES ($1, $2, 'ADJUSTMENT', $3)",
      [productId, quantity, context.get('user').id],
    );
    await db.query(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES ($1, 'STOCK_ADJUSTED', 'product', $2, $3)",
      [context.get('user').id, productId, JSON.stringify({ quantity, reason })],
    );
    await db.query('COMMIT');
    return context.json({ product: product.rows[0] });
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
});

routes.get('/inventory/movements', requireRole('ADMIN'), async (context) => {
  const productId = context.req.query('productId');
  const limit = Math.min(Math.max(Number(context.req.query('limit')) || 100, 1), 500);
  const result = await context.get('db').query(
    `SELECT m.id, m.product_id, p.name AS product_name, m.quantity, m.movement_type,
            m.reference_id, m.created_at, u.name AS user_name
     FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN users u ON u.id = m.user_id
     WHERE ($1::uuid IS NULL OR m.product_id = $1)
     ORDER BY m.created_at DESC LIMIT $2`,
    [productId || null, limit],
  );
  return context.json({ movements: result.rows });
});

routes.get('/expenses', requireRole('ADMIN'), async (context) => {
  const from = context.req.query('from') || null;
  const to = context.req.query('to') || null;
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return context.json({ error: 'Invalid date filter.' }, 400);
  const result = await context.get('db').query(
    `SELECT e.id, e.description, e.amount, e.created_at, u.name AS created_by_name
     FROM expenses e JOIN users u ON u.id = e.created_by
     WHERE ($1::date IS NULL OR e.created_at >= $1::date) AND ($2::date IS NULL OR e.created_at < $2::date + interval '1 day')
     ORDER BY e.created_at DESC LIMIT 200`,
    [from, to],
  );
  return context.json({ expenses: result.rows });
});

routes.post('/expenses', async (context) => {
  const user = context.get('user');
  const body = await context.req.json().catch(() => null) as { description?: unknown; amount?: unknown } | null;
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const amount = Number(body?.amount);
  if (!description || description.length > 250 || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    return context.json({ error: 'Provide an expense description and valid positive amount.' }, 400);
  }
  const db = context.get('db');
  const register = user.role === 'CASHIER'
    ? await db.query("SELECT id FROM register_sessions WHERE cashier_id = $1 AND status = 'OPEN'", [user.id])
    : { rows: [] };
  if (user.role === 'CASHIER' && !register.rows.length) return context.json({ error: 'Open a register before recording an expense.' }, 409);
  const result = await db.query(
    'INSERT INTO expenses (description, amount, created_by, register_session_id) VALUES ($1, $2, $3, $4) RETURNING id, description, amount, created_at',
    [description, amount, user.id, register.rows[0]?.id ?? null],
  );
  await db.query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'EXPENSE_CREATED', 'expense', $2)",
    [user.id, result.rows[0].id],
  );
  return context.json({ expense: result.rows[0] }, 201);
});

routes.get('/audit-logs', requireRole('ADMIN'), async (context) => {
  const result = await context.get('db').query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, u.name AS user_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 200`,
  );
  return context.json({ logs: result.rows });
});

routes.get('/register/sessions', requireRole('ADMIN'), async (context) => {
  const result = await context.get('db').query(
    `SELECT r.id, r.opening_balance, r.closing_balance, r.expected_closing_balance, r.variance,
            r.opened_at, r.closed_at, r.status, u.name AS cashier_name
     FROM register_sessions r JOIN users u ON u.id = r.cashier_id
     ORDER BY r.opened_at DESC LIMIT 200`,
  );
  return context.json({ sessions: result.rows });
});

routes.get('/reports/sales', requireRole('ADMIN'), async (context) => {
  const groupBy = context.req.query('groupBy') ?? 'day';
  const from = context.req.query('from') || null;
  const to = context.req.query('to') || null;
  const groups: Record<string, string> = {
    day: "date_trunc('day', s.created_at)::date::text",
    week: "date_trunc('week', s.created_at)::date::text",
    month: "date_trunc('month', s.created_at)::date::text",
    cashier: 'u.name',
    product: 'si.product_name',
    category: "COALESCE(c.name, 'Uncategorized')",
  };
  if (!(groupBy in groups) || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
    return context.json({ error: 'Invalid report grouping or date filter.' }, 400);
  }
  const groupExpression = groups[groupBy];
  const result = await context.get('db').query(
    `SELECT ${groupExpression} AS label, SUM(si.subtotal) AS revenue, SUM(si.quantity) AS units,
            COUNT(DISTINCT s.id) AS transactions
     FROM sales s JOIN sale_items si ON si.sale_id = s.id
     JOIN users u ON u.id = s.cashier_id
     LEFT JOIN products p ON p.id = si.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE s.status = 'COMPLETED' AND ($1::date IS NULL OR s.created_at >= $1::date)
       AND ($2::date IS NULL OR s.created_at < $2::date + interval '1 day')
     GROUP BY label ORDER BY revenue DESC LIMIT 500`,
    [from, to],
  );
  return context.json({ groupBy, report: result.rows });
});

routes.get('/reports/inventory', requireRole('ADMIN'), async (context) => {
  const result = await context.get('db').query(
    `SELECT p.id, p.name, p.sku, c.name AS category_name, p.stock_quantity, p.low_stock_threshold,
            p.cost_price, p.selling_price, p.stock_quantity <= p.low_stock_threshold AS low_stock
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status = 'ACTIVE' ORDER BY low_stock DESC, p.name LIMIT 1000`,
  );
  return context.json({ inventory: result.rows });
});

routes.get('/reports/expenses', requireRole('ADMIN'), async (context) => {
  const from = context.req.query('from') || null;
  const to = context.req.query('to') || null;
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return context.json({ error: 'Invalid date filter.' }, 400);
  const result = await context.get('db').query(
    `SELECT date_trunc('day', created_at)::date AS day, SUM(amount) AS total, COUNT(*) AS count
     FROM expenses WHERE ($1::date IS NULL OR created_at >= $1::date)
       AND ($2::date IS NULL OR created_at < $2::date + interval '1 day')
     GROUP BY day ORDER BY day DESC LIMIT 366`,
    [from, to],
  );
  return context.json({ report: result.rows });
});

routes.get('/sales/:id', async (context) => {
  const user = context.get('user');
  const sale = await context.get('db').query(
    `SELECT s.*, u.name AS cashier_name FROM sales s JOIN users u ON u.id = s.cashier_id
     WHERE s.id = $1 AND ($2::text = 'ADMIN' OR s.cashier_id = $3)`,
    [context.req.param('id'), user.role, user.id],
  );
  if (!sale.rowCount) return context.json({ error: 'Sale not found.' }, 404);
  const items = await context.get('db').query(
    'SELECT product_name AS name, quantity, unit_price, subtotal FROM sale_items WHERE sale_id = $1 ORDER BY id',
    [context.req.param('id')],
  );
  return context.json({ sale: sale.rows[0], items: items.rows });
});

routes.get('/reports/profit', requireRole('ADMIN'), async (context) => {
  const from = context.req.query('from');
  const to = context.req.query('to');
  const result = await context.get('db').query(
    `SELECT date_trunc('day', s.created_at)::date AS day,
            SUM(si.subtotal) AS revenue,
            SUM(si.quantity * si.unit_cost) AS cost,
            SUM(si.subtotal - si.quantity * si.unit_cost) AS profit
     FROM sales s JOIN sale_items si ON si.sale_id = s.id
     WHERE s.status = 'COMPLETED' AND ($1::date IS NULL OR s.created_at >= $1::date)
       AND ($2::date IS NULL OR s.created_at < $2::date + interval '1 day')
     GROUP BY day ORDER BY day DESC LIMIT 366`,
    [from || null, to || null],
  );
  return context.json({ report: result.rows });
});

export default routes;