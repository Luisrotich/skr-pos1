import { Hono } from 'hono';
import type { AppVariables, Env } from './db';
import {
  clearSessionCookie,
  createSession,
  hashSessionToken,
  requireAuth,
  requireSameOrigin,
  sessionCookie,
  verifyPassword,
  hashPassword,
} from './security';

const routes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

routes.get('/setup/status', async (context) => {
  const result = await context.get('db').query("SELECT NOT EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') AS required");
  return context.json({ setupRequired: result.rows[0].required });
});

routes.post('/setup/initial-admin', requireSameOrigin, async (context) => {
  const body = await context.req.json().catch(() => null) as { name?: unknown; username?: unknown; password?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (name.length < 2 || name.length > 100 || !/^[a-z0-9._-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) {
    return context.json({ error: 'Provide a name, valid username, and password of at least 12 characters.' }, 400);
  }

  const db = context.get('db');
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(6137082501)');
    const existing = await db.query("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1");
    if (existing.rowCount) {
      await db.query('ROLLBACK');
      return context.json({ error: 'Initial setup has already been completed.' }, 409);
    }
    const passwordHash = await hashPassword(password);
    const created = await db.query(
      "INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, 'ADMIN') RETURNING id",
      [name, username, passwordHash],
    );
    await db.query(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'INITIAL_ADMIN_CREATED', 'user', $1)",
      [created.rows[0].id],
    );
    await db.query('COMMIT');
    return context.json({ created: true }, 201);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      return context.json({ error: 'That username is already in use.' }, 409);
    }
    throw error;
  }
});

routes.post('/auth/login', requireSameOrigin, async (context) => {
  const body = await context.req.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password || username.length > 64 || password.length > 256) {
    return context.json({ error: 'Invalid username or password.' }, 401);
  }

  const db = context.get('db');
  const requestIp = context.req.header('CF-Connecting-IP') ?? 'unknown';
  const limitKey = await hashSessionToken(`${requestIp}:${username}`);
  const limit = await db.query(
    `INSERT INTO login_rate_limits (key_hash, attempts) VALUES ($1, 1)
     ON CONFLICT (key_hash) DO UPDATE SET
       attempts = CASE WHEN login_rate_limits.window_started_at <= now() - interval '15 minutes' THEN 1 ELSE login_rate_limits.attempts + 1 END,
       window_started_at = CASE WHEN login_rate_limits.window_started_at <= now() - interval '15 minutes' THEN now() ELSE login_rate_limits.window_started_at END
     RETURNING attempts`,
    [limitKey],
  );
  if (Number(limit.rows[0].attempts) > 10) return context.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);

  const result = await db.query(
    "SELECT id, name, username, role, password_hash FROM users WHERE username = $1 AND status = 'ACTIVE'",
    [username],
  );
  const user = result.rows[0];
  const valid = await verifyPassword(
  password,
  user?.password_hash ??
    'pbkdf2-sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000',
);
  if (!user || !valid) return context.json({ error: 'Invalid username or password.' }, 401);

  await db.query('DELETE FROM login_rate_limits WHERE key_hash = $1', [limitKey]);
  const token = await createSession(db, user.id);
  await db.query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'LOGIN', 'user', $1)",
    [user.id],
  );
  context.header('Set-Cookie', sessionCookie(token));
  return context.json({ user: { id: user.id, name: user.name, username: user.username, role: user.role } });
});

routes.post('/auth/logout', requireSameOrigin, requireAuth, async (context) => {
  const token = context.req.header('Cookie')?.match(/(?:^|;\s*)rotich_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (token) await context.get('db').query('DELETE FROM sessions WHERE token_hash = $1', [await hashSessionToken(token)]);
  context.header('Set-Cookie', clearSessionCookie());
  return context.json({ loggedOut: true });
});

routes.get('/auth/me', requireAuth, (context) => context.json({ user: context.get('user') }));

export default routes;