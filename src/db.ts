import { Pool, type PoolClient } from 'pg';
import type { MiddlewareHandler } from 'hono';

export type Env = {
  HYPERDRIVE: Hyperdrive;
  ASSETS: Fetcher;
};

export type AppVariables = {
  db: PoolClient;
  user: {
    id: string;
    name: string;
    username: string;
    role: 'ADMIN' | 'CASHIER';
  };
};

declare global {
  var __rotich_pool: Pool | undefined;
}

function getDbPool(connectionString: string): Pool {
  if (!globalThis.__rotich_pool) {
    globalThis.__rotich_pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 5_000,
    });
  }
  return globalThis.__rotich_pool;
}

export const databaseMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (context, next) => {
  const pool = getDbPool(context.env.HYPERDRIVE.connectionString);
  const client = await pool.connect().catch((error) => {
    console.error('Database connection error:', error);
    return null;
  });

  if (!client) {
    return context.json(
      { error: 'Database unavailable. Check the Neon connection.' },
      503,
    );
  }

  try {
    context.set('db', client);
    await next();
  } catch (error) {
    console.error('Database error:', error);

    return context.json(
      { error: 'Database unavailable. Check the Neon connection.' },
      503,
    );
  } finally {
    client.release();
  }
};