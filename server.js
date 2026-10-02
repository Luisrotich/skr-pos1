require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const isLocal = !process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

async function initDb(){
  // --- products ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      buy_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
      price       NUMERIC(12,2) NOT NULL,
      stock       INTEGER NOT NULL DEFAULT 0,
      category    TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // --- sales ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      no        INTEGER PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      items     JSONB NOT NULL,
      total     NUMERIC(12,2) NOT NULL,
      method    TEXT NOT NULL,
      code      TEXT NOT NULL DEFAULT '',
      cashier   TEXT NOT NULL DEFAULT 'Cashier'
    );
  `);

  // Repair: add any columns an old/partial sales table might be missing
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS ts      TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS items   JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS total   NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS method  TEXT NOT NULL DEFAULT 'CASH'`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS code    TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier TEXT NOT NULL DEFAULT 'Cashier'`);

  await pool.query(`CREATE INDEX IF NOT EXISTS sales_ts_idx ON sales (ts DESC)`);

  // --- counters ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);

  await pool.query(
    `INSERT INTO counters (name, value) VALUES ('sale', 0)
     ON CONFLICT (name) DO NOTHING`
  );
}
/* ============ Row mappers ============ */
const productRow = r => ({
  id: r.id,
  name: r.name,
  buyPrice: Number(r.buy_price),
  price: Number(r.price),
  stock: r.stock,
  category: r.category
});

const saleRow = r => ({
  no: r.no,
  ts: r.ts,
  items: r.items,
  total: Number(r.total),
  method: r.method,
  code: r.code,
  cashier: r.cashier
});

/* ============ Products ============ */
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY name');
    res.json(rows.map(productRow));
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/products', async (req, res) => {
  try {
    const { id, name, buyPrice, price, stock, category } = req.body || {};
    if (!name || price == null) return res.status(400).json({ error: 'Missing name or price' });
    const pid = id || ('p' + Date.now().toString(36) + Math.random().toString(36).slice(2,6));
    const { rows } = await pool.query(
      `INSERT INTO products (id, name, buy_price, price, stock, category)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [pid, name, Number(buyPrice||0), Number(price), parseInt(stock||0,10), category||'']
    );
    res.json(productRow(rows[0]));
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { name, buyPrice, price, stock, category } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE products SET name=$1, buy_price=$2, price=$3, stock=$4, category=$5
       WHERE id=$6 RETURNING *`,
      [name, Number(buyPrice||0), Number(price), parseInt(stock||0,10), category||'', req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(productRow(rows[0]));
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.patch('/api/products/:id/stock', async (req, res) => {
  try {
    const { stock } = req.body || {};
    const { rows } = await pool.query(
      'UPDATE products SET stock=$1 WHERE id=$2 RETURNING *',
      [parseInt(stock,10), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(productRow(rows[0]));
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

/* ============ Sales ============ */
app.get('/api/sales', async (req, res) => {
  try {
    const { from, to, method, q, limit } = req.query;
    const where = [];
    const params = [];
    if (from){ params.push(from); where.push(`ts >= $${params.length}`); }
    if (to){ params.push(to); where.push(`ts <= $${params.length}`); }
    if (method && method !== 'ALL'){ params.push(method); where.push(`method = $${params.length}`); }
    if (q){
      params.push('%' + String(q).toLowerCase() + '%');
      where.push(`(LOWER(code) LIKE $${params.length} OR items::text ILIKE $${params.length})`);
    }
    let sql = 'SELECT * FROM sales';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY ts DESC';
    if (limit){ params.push(parseInt(limit,10)); sql += ` LIMIT $${params.length}`; }
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(saleRow));
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.get('/api/sales/:no', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sales WHERE no=$1', [req.params.no]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(saleRow(rows[0]));
  } catch (e){ res.status(500).json({ error: e.message }); }
});

/* Atomic: increment counter + insert sale + decrement stock */
app.post('/api/sales', async (req, res) => {
  const { items, method, code, cashier } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items' });
  if (method !== 'CASH' && method !== 'M-PESA') return res.status(400).json({ error: 'Invalid method' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const c = await client.query(
      `UPDATE counters SET value = value + 1 WHERE name='sale' RETURNING value`
    );
    const no = c.rows[0].value;

    const total = items.reduce((a,i) => a + Number(i.price) * Number(i.qty), 0);

    const s = await client.query(
      `INSERT INTO sales (no, items, total, method, code, cashier)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [no, JSON.stringify(items), total, method, code || '', cashier || 'Cashier']
    );

    for (const i of items){
      await client.query(
        `UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2`,
        [Number(i.qty) || 0, i.id]
      );
    }

    await client.query('COMMIT');
    res.json(saleRow(s.rows[0]));
  } catch (e){
    await client.query('ROLLBACK');
    console.error('Sale error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.delete('/api/sales', async (req, res) => {
  try {
    await pool.query('DELETE FROM sales');
    res.json({ ok: true });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

/* ============ Backup / Restore / Reset ============ */
app.get('/api/backup', async (req, res) => {
  try {
    const p = await pool.query('SELECT * FROM products ORDER BY name');
    const s = await pool.query('SELECT * FROM sales ORDER BY no');
    const c = await pool.query(`SELECT value FROM counters WHERE name='sale'`);
    res.json({
      app: 'MY POS',
      version: 2,
      exportedAt: new Date().toISOString(),
      products: p.rows.map(productRow),
      sales: s.rows.map(saleRow),
      seq: c.rows[0]?.value || 0
    });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', async (req, res) => {
  const data = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM products');
    await client.query('DELETE FROM sales');

    for (const p of (data.products || [])){
      await client.query(
        `INSERT INTO products (id,name,buy_price,price,stock,category)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.id, p.name, Number(p.buyPrice||0), Number(p.price), parseInt(p.stock||0,10), p.category||'']
      );
    }
    for (const s of (data.sales || [])){
      await client.query(
        `INSERT INTO sales (no, ts, items, total, method, code, cashier)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [s.no, s.ts, JSON.stringify(s.items), s.total, s.method, s.code||'', s.cashier||'Cashier']
      );
    }
    await client.query(
      `UPDATE counters SET value = $1 WHERE name='sale'`,
      [parseInt(data.seq||0,10)]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e){
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/reset', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sales');
    await client.query('DELETE FROM products');
    await client.query(`UPDATE counters SET value = 0 WHERE name='sale'`);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e){
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ============ Health ============ */
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ============ Boot ============ */
initDb()
  .then(() => {
    app.listen(PORT, () => console.log('POS running on http://localhost:' + PORT));
  })
  .catch(e => {
    console.error('DB init failed:', e);
    process.exit(1);
  });