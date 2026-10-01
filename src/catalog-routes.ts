import { Hono } from 'hono';
import type { AppVariables, Env } from './db';
import { requireAuth, requireRole } from './security';

const routes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

routes.use('*', requireAuth);

routes.get('/products', async (context) => {
  const query = context.req.query('q')?.trim().slice(0, 100) ?? '';
  const categoryId = context.req.query('categoryId');
  const limit = Math.min(Math.max(Number(context.req.query('limit')) || 40, 1), 100);
  const offset = Math.max(Number(context.req.query('offset')) || 0, 0);

  if (!query) {
    const result = await context.get('db').query(
      `SELECT p.id, p.name, p.sku, p.barcode, p.category_id, c.name AS category_name,
              p.selling_price, p.stock_quantity
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.status = 'ACTIVE' AND ($1::uuid IS NULL OR p.category_id = $1)
       ORDER BY p.name LIMIT $2 OFFSET $3`,
      [categoryId || null, limit, offset],
    );
    return context.json({ products: result.rows, limit, offset });
  }

  const searchPattern = query.length >= 2 ? `%${query}%` : `${query}%`;
  const result = await context.get('db').query(
    `SELECT p.id, p.name, p.sku, p.barcode, p.category_id, c.name AS category_name,
            p.selling_price, p.stock_quantity
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status = 'ACTIVE'
       AND ($3::uuid IS NULL OR p.category_id = $3)
       AND (
         p.barcode = $1 OR
         p.sku = $1 OR
         p.name ILIKE $2 OR
         p.sku ILIKE $2
       )
     ORDER BY CASE
       WHEN p.barcode = $1 THEN 0
       WHEN p.sku = $1 THEN 1
       ELSE 2
     END,
     p.name
     LIMIT $4 OFFSET $5`,
    [query, searchPattern, categoryId || null, limit, offset],
  );

  return context.json({ products: result.rows, limit, offset });
});

routes.post('/products', requireRole('ADMIN'), async (context) => {
  const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return context.json({ error: 'Invalid product details.' }, 400);
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const sku = typeof body?.sku === 'string' ? body.sku.trim() : '';
  const sellingPrice = Number(body?.sellingPrice);
  const costPrice = Number(body?.costPrice ?? 0);
  const stockQuantity = Number(body?.stockQuantity ?? 0);
  const threshold = Number(body?.lowStockThreshold ?? 5);

  if (
    !name ||
    name.length > 160 ||
    !sku ||
    sku.length > 80 ||
    !Number.isFinite(sellingPrice) ||
    sellingPrice < 0 ||
    !Number.isFinite(costPrice) ||
    costPrice < 0 ||
    !Number.isInteger(stockQuantity) ||
    stockQuantity < 0 ||
    !Number.isInteger(threshold) ||
    threshold < 0
  ) {
    return context.json({ error: 'Invalid product details.' }, 400);
  }

  const db = context.get('db');

  const created = await db.query(
    `INSERT INTO products (
      name,
      sku,
      barcode,
      category_id,
      selling_price,
      cost_price,
      stock_quantity,
      low_stock_threshold
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      name,
      sku,
      typeof body.barcode === 'string' && body.barcode.trim()
        ? body.barcode.trim()
        : null,
      typeof body.categoryId === 'string' && body.categoryId.trim()
        ? body.categoryId.trim()
        : null,
      sellingPrice,
      costPrice,
      stockQuantity,
      threshold,
    ],
  );

  const product = created.rows[0];

  await db.query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'PRODUCT_CREATED', 'product', $2)",
    [context.get('user').id, product.id],
  );

  return context.json({ product }, 201);
});


routes.delete('/products/:id', requireRole('ADMIN'), async (context) => {
  const result = await context.get('db').query(
    "UPDATE products SET status = 'INACTIVE', updated_at = now() WHERE id = $1 AND status = 'ACTIVE' RETURNING id",
    [context.req.param('id')],
  );
  if (!result.rowCount) return context.json({ error: 'Product not found.' }, 404);
  await context.get('db').query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'PRODUCT_DEACTIVATED', 'product', $2)",
    [context.get('user').id, context.req.param('id')],
  );
  return context.json({ deactivated: true });
});

routes.get('/categories', async (context) => {
  const result = await context.get('db').query(
    "SELECT id, name, description FROM categories WHERE status = 'ACTIVE' ORDER BY name",
  );
  return context.json({ categories: result.rows });
});

routes.post('/categories', requireRole('ADMIN'), async (context) => {
  const body = await context.req.json().catch(() => null) as { name?: unknown; description?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : null;
  if (!name || name.length > 100 || (description && description.length > 500)) return context.json({ error: 'Invalid category details.' }, 400);
  const result = await context.get('db').query(
    'INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING id, name, description',
    [name, description],
  );
  return context.json({ category: result.rows[0] }, 201);
});

routes.put('/categories/:id', requireRole('ADMIN'), async (context) => {
  const body = await context.req.json().catch(() => null) as { name?: unknown; description?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : null;
  if (!name || name.length > 100 || (description && description.length > 500)) return context.json({ error: 'Invalid category details.' }, 400);
  const result = await context.get('db').query(
    "UPDATE categories SET name = $1, description = $2 WHERE id = $3 AND status = 'ACTIVE' RETURNING id, name, description",
    [name, description, context.req.param('id')],
  );
  if (!result.rowCount) return context.json({ error: 'Category not found.' }, 404);
  await context.get('db').query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'CATEGORY_UPDATED', 'category', $2)",
    [context.get('user').id, context.req.param('id')],
  );
  return context.json({ category: result.rows[0] });
});

routes.delete('/categories/:id', requireRole('ADMIN'), async (context) => {
  const result = await context.get('db').query(
    "UPDATE categories SET status = 'INACTIVE' WHERE id = $1 AND status = 'ACTIVE' RETURNING id",
    [context.req.param('id')],
  );
  if (!result.rowCount) return context.json({ error: 'Category not found.' }, 404);
  await context.get('db').query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'CATEGORY_DEACTIVATED', 'category', $2)",
    [context.get('user').id, context.req.param('id')],
  );
  return context.json({ deactivated: true });
});

export default routes;