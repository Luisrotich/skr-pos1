require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

/* ============ Auth config ============ */
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_DAYS = 7;

if (!process.env.JWT_SECRET){
  console.warn('⚠️  JWT_SECRET not set — using a random value. Sessions reset on restart.');
  console.warn('⚠️  Add JWT_SECRET as an environment variable in production.');
}

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============ DB ============ */
const isLocal = !process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

/* ============ Schema ============ */
async function initDb(){
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
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS buy_price NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category  TEXT NOT NULL DEFAULT ''`);

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
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS ts      TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS items   JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS total   NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS method  TEXT NOT NULL DEFAULT 'CASH'`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS code    TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier TEXT NOT NULL DEFAULT 'Cashier'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sales_ts_idx ON sales (ts DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(
    `INSERT INTO counters (name, value) VALUES ('sale', 0) ON CONFLICT (name) DO NOTHING`
  );

  // ---- users ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed the first admin if no users exist
  const c = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (c.rows[0].n === 0){
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin')`,
      [username, hash]
    );
    console.log('================================================');
    console.log('  First admin created');
    console.log('  Username: ' + username);
    console.log('  Password: ' + password);
    console.log('  Change it after your first login!');
    console.log('================================================');
  }
}

/* ============ Row mappers ============ */
const productRow = r => ({
  id: r.id, name: r.name,
  buyPrice: Number(r.buy_price), price: Number(r.price),
  stock: r.stock, category: r.category
});
const saleRow = r => ({
  no: r.no, ts: r.ts, items: r.items,
  total: Number(r.total), method: r.method,
  code: r.code, cashier: r.cashier
});
const userRow = r => ({
  id: r.id, username: r.username, role: r.role, createdAt: r.created_at
});

/* =========================================================
   AUTH
   ========================================================= */
function signToken(user){
  return jwt.sign(
    { uid: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_DAYS + 'd' }
  );
}

function requireAuth(req, res, next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e){
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username.toLowerCase().trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid username or password' });

    const u = rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

    const token = signToken(u);
    res.json({ token, user: userRow(u) });
  } catch (e){
    console.error('Login error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.uid]);
    if (!rows.length) return res.status(401).json({ error: 'User no longer exists' });
    res.json({ user: userRow(rows[0]) });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.uid]);
    if (!rows.length) return res.status(401).json({ error: 'User no longer exists' });

    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.uid]);
    res.json({ ok: true });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

/* ============ Users (admin only) ============ */
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
    res.json(rows.map(userRow));
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireAuth, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING *`,
      [username.toLowerCase().trim(), hash, role === 'admin' ? 'admin' : 'admin']
    );
    res.json(userRow(rows[0]));
  } catch (e){
    if (e.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.uid) return res.status(400).json({ error: 'You cannot delete your own account' });

    const c = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    if (c.rows[0].n <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });

    await pool.query('DELETE FROM users WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

/* =========================================================
   PRODUCTS  (reads open, writes admin-only)
   ========================================================= */
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY name');
    res.json(rows.map(productRow));
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/products', requireAuth, async (req, res) => {
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

app.put('/api/products/:id', requireAuth, async (req, res) => {
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

app.patch('/api/products/:id/stock', requireAuth, async (req, res) => {
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

app.delete('/api/products/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

/* =========================================================
   SALES  (POS creates; admin reads and deletes)
   ========================================================= */
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

/* POS creates sales — open, cashiers don't log in */
app.post('/api/sales', async (req, res) => {
  const { items, method, code, cashier } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items' });
  if (method !== 'CASH' && method !== 'M-PESA') return res.status(400).json({ error: 'Invalid method' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query(`UPDATE counters SET value = value + 1 WHERE name='sale' RETURNING value`);
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

app.delete('/api/sales', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM sales');
    res.json({ ok: true });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

/* ============ Backup / Restore / Reset (admin only) ============ */
app.get('/api/backup', requireAuth, async (req, res) => {
  try {
    const p = await pool.query('SELECT * FROM products ORDER BY name');
    const s = await pool.query('SELECT * FROM sales ORDER BY no');
    const c = await pool.query(`SELECT value FROM counters WHERE name='sale'`);
    res.json({
      app: 'MY POS', version: 3,
      exportedAt: new Date().toISOString(),
      products: p.rows.map(productRow),
      sales: s.rows.map(saleRow),
      seq: c.rows[0]?.value || 0
    });
  } catch (e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', requireAuth, async (req, res) => {
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
    await client.query(`UPDATE counters SET value = $1 WHERE name='sale'`, [parseInt(data.seq||0,10)]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e){
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/reset', requireAuth, async (req, res) => {
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
  .then(() => app.listen(PORT, () => console.log('POS running on http://localhost:' + PORT)))
  .catch(e => { console.error('DB init failed:', e); process.exit(1); });