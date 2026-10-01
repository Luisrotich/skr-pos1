import { Hono } from 'hono';
import type { AppVariables, Env } from './db';
import { hashSessionToken, requireAuth, requireRole } from './security';

const routes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function toCents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

routes.use('*', requireAuth);

routes.get('/register/current', async (context) => {
  const user = context.get('user');
  const result = await context.get('db').query(
    `SELECT id, cashier_id, opening_balance, opened_at FROM register_sessions
     WHERE cashier_id = $1 AND status = 'OPEN'`,
    [user.id],
  );
  return context.json({ register: result.rows[0] ?? null });
});

routes.post('/register/open', requireRole('CASHIER'), async (context) => {
  const body = await context.req.json().catch(() => null) as { openingBalance?: unknown } | null;
  const openingBalance = Number(body?.openingBalance);
  if (!Number.isFinite(openingBalance) || openingBalance < 0 || openingBalance > 1_000_000_000) {
    return context.json({ error: 'Opening balance must be a valid non-negative amount.' }, 400);
  }
  const result = await context.get('db').query(
    `INSERT INTO register_sessions (cashier_id, opening_balance) VALUES ($1, $2)
     RETURNING id, opening_balance, opened_at`,
    [context.get('user').id, openingBalance],
  );
  return context.json({ register: result.rows[0] }, 201);
});

routes.post('/register/close', requireRole('CASHIER'), async (context) => {
  const body = await context.req.json().catch(() => null) as { closingBalance?: unknown } | null;
  const closingBalance = Number(body?.closingBalance);
  if (!Number.isFinite(closingBalance) || closingBalance < 0 || closingBalance > 1_000_000_000) {
    return context.json({ error: 'Closing balance must be a valid non-negative amount.' }, 400);
  }
  const db = context.get('db');
  await db.query('BEGIN');
  try {
    const register = await db.query(
      "SELECT id, opening_balance FROM register_sessions WHERE cashier_id = $1 AND status = 'OPEN' FOR UPDATE",
      [context.get('user').id],
    );
    if (!register.rowCount) {
      await db.query('ROLLBACK');
      return context.json({ error: 'No open register.' }, 409);
    }
    const registerId = register.rows[0].id as string;
    const totals = await db.query(
      `SELECT COALESCE((SELECT SUM(total) FROM sales WHERE register_session_id = $1 AND status = 'COMPLETED'), 0) AS sales,
              COALESCE((SELECT SUM(amount) FROM expenses WHERE register_session_id = $1), 0) AS expenses`,
      [registerId],
    );
    const expected = toCents(register.rows[0].opening_balance) + toCents(totals.rows[0].sales) - toCents(totals.rows[0].expenses);
    const variance = toCents(closingBalance) - expected;
    await db.query(
      `UPDATE register_sessions SET closing_balance = $1, expected_closing_balance = $2,
         variance = $3, closed_at = now(), status = 'CLOSED' WHERE id = $4`,
      [closingBalance, expected / 100, variance / 100, registerId],
    );
    await db.query(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES ($1, 'REGISTER_CLOSED', 'register_session', $2, $3)",
      [context.get('user').id, registerId, JSON.stringify({ expected: expected / 100, variance: variance / 100 })],
    );
    await db.query('COMMIT');
    return context.json({ closed: true, expected: expected / 100, variance: variance / 100 });
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
});

routes.post('/sales', requireRole('CASHIER'), async (context) => {
  const body = await context.req.json().catch(() => null) as {
    items?: { productId?: unknown; quantity?: unknown }[];
    amountPaid?: unknown;
    idempotencyKey?: unknown;
  } | null;
  const items = body?.items;
  const amountPaid = Number(body?.amountPaid);
  const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey) || !Array.isArray(items) || items.length === 0 || items.length > 100 || !Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > 1_000_000_000) {
    return context.json({ error: 'Invalid sale.' }, 400);
  }

  const quantities = new Map<string, number>();
  for (const item of items) {
    if (typeof item.productId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.productId) || !Number.isInteger(item.quantity) || Number(item.quantity) < 1 || Number(item.quantity) > 10_000) {
      return context.json({ error: 'Each item needs a valid product and positive whole-number quantity.' }, 400);
    }
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + Number(item.quantity));
  }

  const payloadHash = await hashSessionToken(JSON.stringify({
    amountPaidCents: toCents(amountPaid),
    items: [...quantities.entries()].sort(([left], [right]) => left.localeCompare(right)),
  }));

  const db = context.get('db');
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);

    const existing = await db.query(
      'SELECT id, idempotency_hash, receipt_number, subtotal, total, amount_paid, change_due, created_at FROM sales WHERE idempotency_key = $1 AND cashier_id = $2',
      [idempotencyKey, context.get('user').id],
    );

    if (existing.rowCount) {
      if (existing.rows[0].idempotency_hash !== payloadHash) {
        await db.query('ROLLBACK');
        return context.json({ error: 'This checkout key has already been used for a different sale.' }, 409);
      }

      const existingItems = await db.query(
        'SELECT product_name AS name, quantity, unit_price AS "unitPrice", subtotal FROM sale_items WHERE sale_id = $1 ORDER BY id',
        [existing.rows[0].id],
      );
      await db.query('COMMIT');
      return context.json({ sale: { ...existing.rows[0], amountPaid: Number(existing.rows[0].amount_paid), change: Number(existing.rows[0].change_due), items: existingItems.rows } }, 201);
    }

    const registerResult = await db.query(
      "SELECT id FROM register_sessions WHERE cashier_id = $1 AND status = 'OPEN' FOR UPDATE",
      [context.get('user').id],
    );
    if (!registerResult.rowCount) {
      await db.query('ROLLBACK');
      return context.json({ error: 'Open a register before completing a sale.' }, 409);
    }

    const registerId = registerResult.rows[0].id as string;
    const productIds = [...quantities.keys()].sort();
    const lockedProducts = await db.query(
      `SELECT id, name, selling_price, cost_price, stock_quantity
       FROM products
       WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'
       ORDER BY id
       FOR UPDATE`,
      [productIds],
    );

    if (lockedProducts.rowCount !== productIds.length) {
      await db.query('ROLLBACK');
      return context.json({ error: 'One or more products are unavailable.' }, 409);
    }

    const productMap = new Map(lockedProducts.rows.map((product) => [product.id as string, product]));
    const saleLines: Array<{ productId: string; productName: string; quantity: number; unitPriceCents: number; unitCostCents: number; lineCents: number }> = [];
    let subtotalCents = 0;

    for (const [productId, quantity] of [...quantities.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const product = productMap.get(productId);
      if (!product) {
        await db.query('ROLLBACK');
        return context.json({ error: 'One or more products are unavailable.' }, 409);
      }

      const stockQuantity = Number(product.stock_quantity);
      if (stockQuantity < quantity) {
        await db.query('ROLLBACK');
        return context.json({ error: `Insufficient stock for ${String(product.name)}.` }, 409);
      }

      const unitPriceCents = toCents(product.selling_price as string);
      const unitCostCents = toCents(product.cost_price as string);
      const lineCents = unitPriceCents * quantity;
      subtotalCents += lineCents;

      saleLines.push({
        productId,
        productName: String(product.name),
        quantity,
        unitPriceCents,
        unitCostCents,
        lineCents,
      });
    }

    const paidCents = toCents(amountPaid);
    if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(paidCents) || paidCents < subtotalCents) {
      await db.query('ROLLBACK');
      return context.json({ error: 'Amount received is less than the sale total.' }, 400);
    }

    const receiptNumber = `R-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const saleResult = await db.query(
      `INSERT INTO sales (idempotency_key, idempotency_hash, receipt_number, cashier_id, register_session_id, subtotal, total, amount_paid, change_due)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
       RETURNING id, receipt_number, created_at`,
      [idempotencyKey, payloadHash, receiptNumber, context.get('user').id, registerId, subtotalCents / 100, paidCents / 100, (paidCents - subtotalCents) / 100],
    );

    const sale = saleResult.rows[0];
    const itemInsertValues: Array<[string, string, number, number, number, number]> = saleLines.map((line) => [sale.id, line.productId, line.quantity, line.unitPriceCents / 100, line.unitCostCents / 100, line.lineCents / 100]);

    for (const value of itemInsertValues) {
      await db.query(
        'INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost, subtotal) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [sale.id, value[1], productMap.get(value[1])?.name ?? '', value[2], value[3], value[4], value[5]],
      );
    }

    const stockUpdatePayload = JSON.stringify(saleLines.map((line) => ({ id: line.productId, quantity: line.quantity })));
    const stockUpdate = await db.query(
      `UPDATE products p
       SET stock_quantity = p.stock_quantity - v.quantity,
           updated_at = now()
       FROM (
         SELECT id, quantity
         FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, quantity integer)
       ) AS v
       WHERE p.id = v.id AND p.status = 'ACTIVE' AND p.stock_quantity >= v.quantity
       RETURNING p.id`,
      [stockUpdatePayload],
    );

    if (stockUpdate.rowCount !== saleLines.length) {
      throw new Error('INSUFFICIENT_STOCK');
    }

    const movementValues = saleLines.map((line) => `($1, $2, 'SALE', $3, $4)`).join(', ');
    const movementParams: unknown[] = [];
    saleLines.forEach((line) => {
      movementParams.push(line.productId, -line.quantity, sale.id, context.get('user').id);
    });
    await db.query(
      `INSERT INTO stock_movements (product_id, quantity, movement_type, reference_id, user_id)
       VALUES ${movementValues}`,
      movementParams,
    );

    await db.query(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES ($1, 'SALE_COMPLETED', 'sale', $2, $3)",
      [context.get('user').id, sale.id, JSON.stringify({ receiptNumber, total: subtotalCents / 100 })],
    );

    await db.query('COMMIT');
    return context.json({
      sale: {
        ...sale,
        subtotal: subtotalCents / 100,
        total: subtotalCents / 100,
        amountPaid: paidCents / 100,
        change: (paidCents - subtotalCents) / 100,
        paymentMethod: 'CASH',
        items: saleLines.map((line) => ({ name: line.productName, quantity: line.quantity, unitPrice: line.unitPriceCents / 100, subtotal: line.lineCents / 100 })),
      },
    }, 201);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && error.message.startsWith('INSUFFICIENT_STOCK')) {
      return context.json({ error: 'Insufficient stock for one or more products.' }, 409);
    }
    throw error;
  }
});

routes.post('/sales/:id/void', requireRole('ADMIN'), async (context) => {
  const body = await context.req.json().catch(() => null) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) return context.json({ error: 'Provide a void reason.' }, 400);
  const db = context.get('db');
  await db.query('BEGIN');
  try {
    const sale = await db.query('SELECT id, status, receipt_number FROM sales WHERE id = $1 FOR UPDATE', [context.req.param('id')]);
    if (!sale.rowCount) {
      await db.query('ROLLBACK');
      return context.json({ error: 'Sale not found.' }, 404);
    }
    if (sale.rows[0].status !== 'COMPLETED') {
      await db.query('ROLLBACK');
      return context.json({ error: 'Only completed sales can be voided.' }, 409);
    }
    const items = await db.query('SELECT product_id, quantity FROM sale_items WHERE sale_id = $1 ORDER BY product_id FOR UPDATE', [sale.rows[0].id]);
    for (const item of items.rows) {
      await db.query('UPDATE products SET stock_quantity = stock_quantity + $1, updated_at = now() WHERE id = $2', [item.quantity, item.product_id]);
      await db.query(
        "INSERT INTO stock_movements (product_id, quantity, movement_type, reference_id, user_id) VALUES ($1, $2, 'VOID', $3, $4)",
        [item.product_id, item.quantity, sale.rows[0].id, context.get('user').id],
      );
    }
    await db.query("UPDATE sales SET status = 'VOIDED' WHERE id = $1", [sale.rows[0].id]);
    await db.query(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES ($1, 'SALE_VOIDED', 'sale', $2, $3)",
      [context.get('user').id, sale.rows[0].id, JSON.stringify({ receiptNumber: sale.rows[0].receipt_number, reason })],
    );
    await db.query('COMMIT');
    return context.json({ voided: true, receiptNumber: sale.rows[0].receipt_number });
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
});

routes.get('/sales', async (context) => {
  const user = context.get('user');
  const limit = Math.min(Math.max(Number(context.req.query('limit')) || 30, 1), 100);
  const from = context.req.query('from') || null;
  const to = context.req.query('to') || null;
  const receipt = context.req.query('receipt')?.trim().slice(0, 80) ?? '';
  const requestedCashier = context.req.query('cashierId') || null;
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) || (requestedCashier && !/^[0-9a-f-]{36}$/i.test(requestedCashier))) {
    return context.json({ error: 'Invalid sales filter.' }, 400);
  }
  const cashierId = user.role === 'ADMIN' ? requestedCashier : user.id;
  const result = await context.get('db').query(
    `SELECT s.id, s.receipt_number, s.subtotal, s.discount, s.tax, s.total, s.payment_method, s.status, s.created_at,
            u.name AS cashier_name
     FROM sales s JOIN users u ON u.id = s.cashier_id
     WHERE ($1::uuid IS NULL OR s.cashier_id = $1)
       AND ($2::date IS NULL OR s.created_at >= $2::date)
       AND ($3::date IS NULL OR s.created_at < $3::date + interval '1 day')
       AND ($4 = '' OR s.receipt_number ILIKE '%' || $4 || '%')
     ORDER BY s.created_at DESC LIMIT $5`,
    [cashierId, from, to, receipt, limit],
  );
  return context.json({ sales: result.rows });
});

export default routes;