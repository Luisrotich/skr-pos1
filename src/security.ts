import type { MiddlewareHandler } from 'hono';
import { Client } from 'pg';
import type { AppVariables, Env } from './db';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(result));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const result = await crypto.subtle.deriveBits(
    { name: 'PBKDF2',
        hash: 'SHA-256',
         salt, 
         iterations: 100_000
         },
    key,
    256,
  );
  return `pbkdf2-sha256$100000$${toHex(salt)}$${toHex(new Uint8Array(result))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, expectedText] = encoded.split('$');
  const iterations = Number(iterationsText);
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 100_000 || !saltText || !expectedText) return false;
  const salt = Uint8Array.from(saltText.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  const expected = Uint8Array.from(expectedText.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  if (salt.length !== 16 || expected.length !== 32) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const result = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  ));
  let difference = 0;
  for (let index = 0; index < result.length; index += 1) difference |= result[index] ^ expected[index];
  return difference === 0;
}

export async function createSession(db: Client, userId: string): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digest(token);
  await db.query('DELETE FROM sessions WHERE user_id = $1 OR expires_at <= now()', [userId]);
  await db.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'12 hours\')',
    [userId, tokenHash],
  );
  return token;
}

export function sessionCookie(token: string): string {
  return `rotich_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function clearSessionCookie(): string {
  return 'rotich_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
}

export async function hashSessionToken(token: string): Promise<string> {
  return digest(token);
}

export const requireAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (context, next) => {
  const token = context.req.header('Cookie')?.match(/(?:^|;\s*)rotich_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return context.json({ error: 'Authentication required' }, 401);
  const db = context.get('db');
  const result = await db.query(
    `SELECT u.id, u.name, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'ACTIVE'`,
    [await digest(token)],
  );
  if (!result.rowCount) return context.json({ error: 'Authentication required' }, 401);
  context.set('user', result.rows[0]);
  await next();
};

export function requireRole(role: 'ADMIN' | 'CASHIER'): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (context, next) => {
    if (context.get('user')?.role !== role) return context.json({ error: 'Forbidden' }, 403);
    await next();
  };
}
export const requireSameOrigin: MiddlewareHandler = async (context, next) => {
  const origin = context.req.header('Origin');

  if (origin) {
    try {
      const originUrl = new URL(origin);

      // Wrangler remote development uses a local browser origin
      // while the request is processed through Cloudflare's remote proxy.
      // Allow only the local development origins.
     const isLocalDevelopment =
  originUrl.protocol === 'http:' &&
  (
    originUrl.hostname === '127.0.0.1' ||
    originUrl.hostname === 'localhost'
  );

      if (isLocalDevelopment) {
        await next();
        return;
      }

      // Production: require the Origin to match the actual request origin.
      const requestOrigin = new URL(context.req.url).origin;

      if (originUrl.origin !== requestOrigin) {
        return context.json({ error: 'Invalid request origin' }, 403);
      }
    } catch {
      return context.json({ error: 'Invalid request origin' }, 403);
    }
  }

  await next();
};